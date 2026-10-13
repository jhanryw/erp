import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { getWholesaleSiteSettings } from './settings'
import { createFakeAdmin, createOrdersRpc, type FakeTables } from './fakeSupabase.testutil'
import { createWholesaleOrder, type CreateOrderInput } from './orders'
import { ANONYMOUS_CUSTOMER_NAME, anonymousPhoneFor, isAnonymousContact, isAnonymousPhone } from '@/lib/wholesale/anonymousCustomer'
import { buildOrderWhatsAppMessage, formatPhoneBR } from '@/lib/wholesale/whatsapp'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('./settings', () => ({ getWholesaleSiteSettings: vi.fn() }))
vi.mock('@/lib/errors/log', () => ({ logError: vi.fn() }))

const COMPANY = 1
const KEY_A = '11111111-1111-4111-8111-111111111111'
const KEY_B = '22222222-2222-4222-8222-222222222222'
let tables: FakeTables
let rpcCalls: number

function setup(rpcOpts: Parameters<typeof createOrdersRpc>[0] = {}) {
  tables = {
    products: [{ id: 1, name: 'Produto 1', company_id: COMPANY, active: true, wholesale_enabled: true, wholesale_price: 39.9 }],
    product_variations: [{ id: 10, product_id: 1, sku_variation: 'SKU-10', active: true, wholesale_price_override: null }],
    stock_balances: [{ product_variation_id: 10, stock_location_id: 1, quantity: 5000 }],
    product_variation_attributes: [], variation_types: [], variation_values: [],
    stock_locations: [{ id: 1, company_id: COMPANY, active: true }],
    wholesale_orders: [], wholesale_order_items: [], wholesale_order_counters: [],
  }
  rpcCalls = 0
  const inner = createOrdersRpc(rpcOpts)
  const admin = createFakeAdmin(tables, { rpc: (name, args, t) => { rpcCalls++; return inner(name, args, t) } })
  ;(createAdminClient as any).mockReturnValue(admin)
  ;(getWholesaleSiteSettings as any).mockResolvedValue({ minimumOrderAmount: 100, whatsappPhone: '84988887777' })
}

const input = (over: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
  companyId: COMPANY, settings: { whatsappPhone: '84988887777' }, idempotencyKey: KEY_A,
  items: [{ variationId: 10, quantity: 3 }], clientIp: '203.0.113.5', ...over,
})
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

beforeEach(() => { vi.resetAllMocks(); setup() })

describe('pedido sem contato — banco COM a migration (NULL/NULL)', () => {
  it('grava nome e telefone NULL (sem dados fictícios) e totais corretos', async () => {
    const r = await createWholesaleOrder(input())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.order.customerName).toBeNull()
    expect(r.order.customerPhone).toBeNull()
    expect(tables.wholesale_orders[0]).toMatchObject({ customer_name: null, customer_phone: null })
    expect(r.order).toMatchObject({ totalItems: 3, subtotal: 119.7 })
    expect(rpcCalls).toBe(1)
  })

  it('idempotência: mesma chave devolve o mesmo pedido, sem duplicar', async () => {
    const first = await createWholesaleOrder(input())
    const replay = await createWholesaleOrder(input())
    expect(first.ok && replay.ok && replay.replay).toBe(true)
    expect(first.ok && replay.ok && replay.order.id === first.order.id).toBe(true)
    expect(tables.wholesale_orders).toHaveLength(1)
  })

  it('mínimo e estoque continuam valendo; nada é gravado quando recusa', async () => {
    expect(await createWholesaleOrder(input({ items: [{ variationId: 10, quantity: 1 }] }))).toMatchObject({ ok: false, status: 422, error: 'below_minimum' })
    expect(await createWholesaleOrder(input({ items: [{ variationId: 10, quantity: 99999 }] }))).toMatchObject({ ok: false })
    expect(tables.wholesale_orders).toHaveLength(0)
  })

  it('contato INFORMADO continua validado e gravado como antes', async () => {
    expect(await createWholesaleOrder(input({ customer: { name: 'Ana', phone: '123' } }))).toMatchObject({ ok: false, error: 'invalid_customer' })
    const ok = await createWholesaleOrder(input({ customer: { name: 'Maria Silva', phone: '(84) 99999-9999' } }))
    expect(ok.ok && [ok.order.customerName, ok.order.customerPhone]).toEqual(['Maria Silva', '+5584999999999'])
  })
})

describe('anti-spam sem telefone: IP e teto por empresa (equivalentes ao limite por telefone, que já era contornável)', () => {
  const place = async (n: number, over: Partial<CreateOrderInput> = {}) => createWholesaleOrder(input({ idempotencyKey: uuid(n), ...over }))

  it('o MESMO IP para de criar pedidos anônimos após o limite por hora (30)', async () => {
    for (let i = 1; i <= 30; i++) expect((await place(i)).ok).toBe(true)
    expect(await place(31)).toMatchObject({ ok: false, status: 429, error: 'rate_limited' })
    // outro IP segue normal
    expect((await place(32, { clientIp: '198.51.100.7' })).ok).toBe(true)
  })

  it('o teto por empresa (200/h) vale mesmo com IPs diferentes e sem IP nenhum', async () => {
    tables.wholesale_orders.push(...Array.from({ length: 200 }, (_, i) => ({
      id: `x${i}`, company_id: COMPANY, code: `AT-${i}`, customer_name: null, customer_phone: null,
      request_ip_hash: `ip-${i}`, idempotency_key: uuid(1000 + i), created_at: new Date().toISOString(),
    })))
    expect(await place(1, { clientIp: null })).toMatchObject({ ok: false, status: 429, error: 'rate_limited' })
    expect(await place(2, { clientIp: '198.51.100.9' })).toMatchObject({ ok: false, status: 429 })
  })

  it('o limite por TELEFONE segue valendo para quem informa contato (10/h)', async () => {
    const contact = { name: 'Maria Silva', phone: '(84) 99999-9999' }
    for (let i = 1; i <= 10; i++) expect((await place(i, { customer: contact, clientIp: `198.51.100.${i}` })).ok).toBe(true)
    expect(await place(11, { customer: contact, clientIp: '198.51.100.99' })).toMatchObject({ ok: false, status: 429 })
  })

  it('pedidos anônimos não se agrupam num "telefone" comum (NULL nunca conta)', async () => {
    for (let i = 1; i <= 12; i++) expect((await place(i, { clientIp: `198.51.100.${i}` })).ok).toBe(true)
  })
})

describe('IP desconhecido: balde próprio (não desliga a proteção por IP)', () => {
  const place = (n: number, over: Partial<CreateOrderInput> = {}) => createWholesaleOrder(input({ idempotencyKey: uuid(n), ...over }))
  const withEnv = async (env: Record<string, string>, fn: () => Promise<void>) => {
    Object.assign(process.env, env)
    try { await fn() } finally { for (const k of Object.keys(env)) delete process.env[k] }
  }

  it('sem IP confiável todos compartilham o limite do balde desconhecido (60/h) — e depois são limitados', async () => {
    for (let i = 1; i <= 60; i++) expect((await place(i, { clientIp: null })).ok).toBe(true)
    const blocked = await place(61, { clientIp: null })
    expect(blocked).toMatchObject({ ok: false, status: 429, error: 'rate_limited' })
    // quem tem IP confiável não é afetado pelo balde desconhecido
    expect((await place(62, { clientIp: '198.51.100.7' })).ok).toBe(true)
  })

  it('limite do balde é configurável por WHOLESALE_ORDERS_UNKNOWN_IP_PER_HOUR', async () => {
    await withEnv({ WHOLESALE_ORDERS_UNKNOWN_IP_PER_HOUR: '3' }, async () => {
      for (let i = 1; i <= 3; i++) expect((await place(i, { clientIp: null })).ok).toBe(true)
      expect(await place(4, { clientIp: null })).toMatchObject({ ok: false, error: 'rate_limited' })
    })
  })

  it('o balde desconhecido não usa o limite por-IP de 30 (clientes legítimos atrás de proxy sem config não são cortados cedo)', async () => {
    for (let i = 1; i <= 31; i++) expect((await place(i, { clientIp: null })).ok).toBe(true)
  })

  it('o teto por empresa e a idempotência continuam valendo sem IP', async () => {
    const first = await place(1, { clientIp: null })
    const replay = await place(1, { clientIp: null })
    expect(first.ok && replay.ok && replay.replay).toBe(true)
    expect(tables.wholesale_orders).toHaveLength(1)
  })

  it('rate_limited carrega as linhas VALIDADAS do servidor para o fallback; outros erros nunca', async () => {
    await withEnv({ WHOLESALE_ORDERS_UNKNOWN_IP_PER_HOUR: '1' }, async () => {
      await place(1, { clientIp: null })
      const limited = await place(2, { clientIp: null })
      expect(limited).toMatchObject({ ok: false, status: 429 })
      if (limited.ok) return
      expect(limited.fallbackLines).toEqual([expect.objectContaining({ variationId: 10, quantity: 3, unitPrice: 39.9, productName: 'Produto 1' })])
    })
    const below = await place(3, { clientIp: '198.51.100.1', items: [{ variationId: 10, quantity: 1 }] })
    expect(below).toMatchObject({ ok: false, error: 'below_minimum' })
    expect(below.ok ? null : below.fallbackLines).toBeUndefined()
    const stock = await place(4, { clientIp: '198.51.100.1', items: [{ variationId: 10, quantity: 99999 }] })
    expect(stock.ok ? null : stock.fallbackLines).toBeUndefined()
  })
})

describe('transição: banco AINDA sem a migration (NOT NULL)', () => {
  beforeEach(() => setup({ requireContact: true }))

  it('tenta NULL, recebe 23502 e regrava UMA vez com a identidade de reserva — o cliente compra normalmente', async () => {
    const r = await createWholesaleOrder(input())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(rpcCalls).toBe(2)
    expect(r.order.customerName).toBe(ANONYMOUS_CUSTOMER_NAME)
    expect(isAnonymousPhone(r.order.customerPhone)).toBe(true)
    expect(r.order.customerPhone).toBe(anonymousPhoneFor(KEY_A))
    expect(tables.wholesale_orders).toHaveLength(1) // sem pedido parcial/duplicado
    expect(tables.wholesale_order_counters[0].last_number).toBe(1) // contador sem buraco
  })

  it('replay nessa transição continua idempotente', async () => {
    await createWholesaleOrder(input())
    const again = await createWholesaleOrder(input())
    expect(again.ok && again.replay).toBe(true)
    expect(tables.wholesale_orders).toHaveLength(1)
  })

  it('contato informado nunca passa pelo fallback (não usa dados fictícios)', async () => {
    const r = await createWholesaleOrder(input({ customer: { name: 'Maria Silva', phone: '(84) 99999-9999' } }))
    expect(r.ok && r.order.customerPhone).toBe('+5584999999999')
    expect(rpcCalls).toBe(1)
  })
})

describe('exibição e mensagem (NULL e marcador legado)', () => {
  it('isAnonymousContact reconhece NULL e o marcador antigo; telefone real não', () => {
    expect(isAnonymousContact(null)).toBe(true)
    expect(isAnonymousContact(anonymousPhoneFor(KEY_A))).toBe(true)
    expect(isAnonymousContact('+5584999999999')).toBe(false)
    expect(formatPhoneBR(null)).toBe('Não informado')
    expect(formatPhoneBR(anonymousPhoneFor(KEY_B))).toBe('Não informado')
  })

  it('mensagem do WhatsApp: produtos, variações, quantidades, valores e total — sem Cliente/WhatsApp', async () => {
    const r = await createWholesaleOrder(input())
    if (!r.ok) throw new Error('setup')
    const built = buildOrderWhatsAppMessage(
      { ...r.order, items: r.order.items.map((i) => ({ ...i, attributes: [{ type: 'Cor', value: 'Rosa' }, { type: 'Tamanho', value: 'P/M' }] })) },
      '84988887777',
    )!
    for (const part of [`PEDIDO ATACADO — ${r.order.code}`, 'Produto 1', 'Cor: Rosa', 'Tamanho: P/M', '3 un. × R$ 39,90', 'Total de peças: 3', 'Total do pedido: R$ 119,70']) {
      expect(built.message).toContain(part)
    }
    expect(built.message).not.toContain('Cliente:')
    expect(built.message).not.toContain('null')
    expect(built.url.startsWith('https://wa.me/5584988887777?text=')).toBe(true)
  })

  it('pedido legado com marcador fictício também não vaza o número na mensagem', async () => {
    setup({ requireContact: true })
    const r = await createWholesaleOrder(input())
    if (!r.ok) throw new Error('setup')
    const message = buildOrderWhatsAppMessage(r.order, '84988887777')!.message
    expect(message).not.toContain('Cliente:')
    expect(message).not.toContain('+5500')
  })

  it('pedido com contato real mantém Cliente/WhatsApp', async () => {
    const r = await createWholesaleOrder(input({ customer: { name: 'Maria Silva', phone: '(84) 99999-9999' } }))
    if (!r.ok) throw new Error('setup')
    expect(buildOrderWhatsAppMessage(r.order, '84988887777')!.message).toContain('Cliente: Maria Silva')
  })
})
