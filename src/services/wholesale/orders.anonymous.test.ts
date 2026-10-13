import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { getWholesaleSiteSettings } from './settings'
import { createFakeAdmin, createOrdersRpc, type FakeTables } from './fakeSupabase.testutil'
import { createWholesaleOrder, type CreateOrderInput } from './orders'
import { ANONYMOUS_CUSTOMER_NAME, anonymousPhoneFor, isAnonymousPhone } from '@/lib/wholesale/anonymousCustomer'
import { buildOrderWhatsAppMessage, formatPhoneBR } from '@/lib/wholesale/whatsapp'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('./settings', () => ({ getWholesaleSiteSettings: vi.fn() }))
vi.mock('@/lib/errors/log', () => ({ logError: vi.fn() }))

const COMPANY = 1
const KEY_A = '11111111-1111-4111-8111-111111111111'
const KEY_B = '22222222-2222-4222-8222-222222222222'
let tables: FakeTables

function setup() {
  tables = {
    products: [{ id: 1, name: 'Produto 1', company_id: COMPANY, active: true, wholesale_enabled: true, wholesale_price: 39.9 }],
    product_variations: [{ id: 10, product_id: 1, sku_variation: 'SKU-10', active: true, wholesale_price_override: null }],
    stock_balances: [{ product_variation_id: 10, stock_location_id: 1, quantity: 50 }],
    product_variation_attributes: [], variation_types: [], variation_values: [],
    stock_locations: [{ id: 1, company_id: COMPANY, active: true }],
    wholesale_orders: [], wholesale_order_items: [], wholesale_order_counters: [],
  }
  ;(createAdminClient as any).mockReturnValue(createFakeAdmin(tables, { rpc: createOrdersRpc() }))
  ;(getWholesaleSiteSettings as any).mockResolvedValue({ minimumOrderAmount: 100, whatsappPhone: '84988887777' })
}

const input = (over: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
  companyId: COMPANY, settings: { whatsappPhone: '84988887777' }, idempotencyKey: KEY_A,
  items: [{ variationId: 10, quantity: 3 }], clientIp: '203.0.113.5', ...over,
})

beforeEach(() => { vi.resetAllMocks(); setup() })

describe('pedido sem nome/WhatsApp digitados (identidade anônima)', () => {
  it('é aceito e registrado com marcador anônimo que satisfaz as constraints do banco', async () => {
    const r = await createWholesaleOrder(input())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.order.customerName).toBe(ANONYMOUS_CUSTOMER_NAME)
    expect(r.order.customerName.length).toBeGreaterThanOrEqual(2)
    expect(r.order.customerPhone).toMatch(/^\+55[0-9]{10,11}$/) // CHECK de wholesale_orders.customer_phone
    expect(isAnonymousPhone(r.order.customerPhone)).toBe(true)
    expect(r.order).toMatchObject({ totalItems: 3, subtotal: 119.7 })
  })

  it('telefone anônimo é único por pedido (não agrupa visitantes no limite por telefone) e estável no replay', async () => {
    expect(anonymousPhoneFor(KEY_A)).not.toBe(anonymousPhoneFor(KEY_B))
    expect(anonymousPhoneFor(KEY_A)).toBe(anonymousPhoneFor(KEY_A))
    const first = await createWholesaleOrder(input())
    const replay = await createWholesaleOrder(input())
    expect(first.ok && replay.ok && replay.replay).toBe(true)
    expect(tables.wholesale_orders).toHaveLength(1)
  })

  it('mínimo e estoque continuam valendo sem contato', async () => {
    const below = await createWholesaleOrder(input({ items: [{ variationId: 10, quantity: 1 }] })) // 39,90 < 100
    expect(below).toMatchObject({ ok: false, status: 422, error: 'below_minimum' })
    const over = await createWholesaleOrder(input({ items: [{ variationId: 10, quantity: 999 }] }))
    expect(over).toMatchObject({ ok: false, status: 409 })
    expect(tables.wholesale_orders).toHaveLength(0)
  })

  it('contato INFORMADO (API) continua sendo validado como antes', async () => {
    expect(await createWholesaleOrder(input({ customer: { name: 'Ana', phone: '123' } }))).toMatchObject({ ok: false, error: 'invalid_customer' })
    const ok = await createWholesaleOrder(input({ customer: { name: 'Maria Silva', phone: '(84) 99999-9999' } }))
    expect(ok.ok && ok.order.customerPhone).toBe('+5584999999999')
  })
})

describe('mensagem de WhatsApp e telas do ERP para pedido anônimo', () => {
  it('a mensagem traz produtos, variações, quantidades, valores e total — sem nome/telefone fictício', async () => {
    const r = await createWholesaleOrder(input())
    if (!r.ok) throw new Error('setup')
    const built = buildOrderWhatsAppMessage(
      { ...r.order, items: r.order.items.map((i) => ({ ...i, attributes: [{ type: 'Cor', value: 'Rosa' }, { type: 'Tamanho', value: 'P/M' }] })) },
      '84988887777',
    )!
    expect(built.message).toContain(`PEDIDO ATACADO — ${r.order.code}`)
    expect(built.message).toContain('Produto 1')
    expect(built.message).toContain('Cor: Rosa')
    expect(built.message).toContain('Tamanho: P/M')
    expect(built.message).toContain('3 un. × R$ 39,90')
    expect(built.message).toContain('Total de peças: 3')
    expect(built.message).toContain('Total do pedido: R$ 119,70')
    expect(built.message).not.toContain('Cliente:')
    expect(built.message).not.toContain('+5500')
    expect(built.message).not.toMatch(/\(00\)/)
    expect(built.url.startsWith('https://wa.me/5584988887777?text=')).toBe(true)
  })

  it('pedido com contato real mantém Cliente/WhatsApp na mensagem', async () => {
    const r = await createWholesaleOrder(input({ customer: { name: 'Maria Silva', phone: '(84) 99999-9999' } }))
    if (!r.ok) throw new Error('setup')
    expect(buildOrderWhatsAppMessage(r.order, '84988887777')!.message).toContain('Cliente: Maria Silva')
  })

  it('ERP nunca exibe o número fictício', () => {
    expect(formatPhoneBR(anonymousPhoneFor(KEY_A))).toBe('Não informado')
    expect(formatPhoneBR('+5584999999999')).toBe('(84) 99999-9999')
  })
})
