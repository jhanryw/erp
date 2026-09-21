import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { getWholesaleSiteSettings } from './settings'
import { createFakeAdmin, createOrdersRpc, type FakeTables } from './fakeSupabase.testutil'
import { createWholesaleOrder, hashRequestIp, normalizeCustomerName, type CreateOrderInput } from './orders'
import { getWholesaleOrder, listWholesaleOrders, updateWholesaleOrderStatus } from './ordersAdmin'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('./settings', () => ({ getWholesaleSiteSettings: vi.fn() }))
vi.mock('@/lib/errors/log', () => ({ logError: vi.fn() }))

const COMPANY = 1
const OTHER = 2
const KEY_A = '11111111-1111-4111-8111-111111111111'
const KEY_B = '22222222-2222-4222-8222-222222222222'

interface V { id: number; product: number; sku: string; price?: number | null; stock?: number; active?: boolean; enabled?: boolean; productActive?: boolean; company?: number; attrs?: [string, string][] }

let tables: FakeTables
function setup(variations: V[], opts: { minimum?: number; failOnItemIndex?: number } = {}) {
  tables = {
    products: [], product_variations: [], stock_balances: [], product_variation_attributes: [],
    variation_types: [{ id: 1, name: 'Tamanho' }, { id: 2, name: 'Cor' }],
    variation_values: [{ id: 1, value: 'M' }, { id: 2, value: 'Preto' }, { id: 3, value: 'G' }, { id: 4, value: 'Bege' }],
    stock_locations: [{ id: 1, company_id: COMPANY, active: true }, { id: 2, company_id: OTHER, active: true }],
    wholesale_orders: [], wholesale_order_items: [], wholesale_order_counters: [],
  }
  for (const v of variations) {
    const company = v.company ?? COMPANY
    if (!tables.products.find((p) => p.id === v.product)) {
      tables.products.push({ id: v.product, name: `Produto ${v.product}`, company_id: company, active: v.productActive ?? true, wholesale_enabled: v.enabled ?? true, wholesale_price: v.price === undefined ? 39.9 : v.price })
    }
    tables.product_variations.push({ id: v.id, product_id: v.product, sku_variation: v.sku, active: v.active ?? true, wholesale_price_override: null })
    tables.stock_balances.push({ product_variation_id: v.id, stock_location_id: company === COMPANY ? 1 : 2, quantity: v.stock ?? 50 })
    const valueIds: Record<string, number> = { M: 1, Preto: 2, G: 3, Bege: 4 }
    for (const [type, value] of v.attrs ?? []) tables.product_variation_attributes.push({ product_variation_id: v.id, variation_type_id: type === 'Tamanho' ? 1 : 2, variation_value_id: valueIds[value] })
  }
  ;(createAdminClient as any).mockReturnValue(createFakeAdmin(tables, { rpc: createOrdersRpc({ failOnItemIndex: opts.failOnItemIndex }) }))
  ;(getWholesaleSiteSettings as any).mockResolvedValue({ minimumOrderAmount: opts.minimum ?? 100, whatsappPhone: '84988887777' })
}

const input = (over: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
  companyId: COMPANY, settings: { whatsappPhone: '84988887777' }, idempotencyKey: KEY_A,
  customer: { name: 'Maria Silva', phone: '(84) 99999-9999' }, items: [{ variationId: 10, quantity: 3 }], clientIp: '203.0.113.5', ...over,
})
const BASE: V[] = [{ id: 10, product: 1, sku: 'NUA-M-PRETO', attrs: [['Tamanho', 'M'], ['Cor', 'Preto']] }]

beforeEach(() => vi.resetAllMocks())

describe('createWholesaleOrder — criação', () => {
  it('pedido válido: código AT-, snapshot completo do banco, totais corretos', async () => {
    setup(BASE)
    const r = await createWholesaleOrder(input())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.replay).toBe(false)
    expect(r.order).toMatchObject({ code: 'AT-000001', status: 'pending', customerName: 'Maria Silva', customerPhone: '+5584999999999', totalItems: 3, subtotal: 119.7, minimumOrderAmount: 100 })
    expect(r.order.items).toEqual([{
      position: 1, variationId: 10, productId: 1, productName: 'Produto 1', sku: 'NUA-M-PRETO',
      attributes: [{ type: 'Tamanho', value: 'M' }, { type: 'Cor', value: 'Preto' }], quantity: 3, unitPrice: 39.9, subtotal: 119.7,
    }])
  })

  it('NÃO cria venda e NÃO baixa estoque', async () => {
    setup(BASE)
    await createWholesaleOrder(input())
    expect(tables.stock_balances[0].quantity).toBe(50)
    expect(tables.sales).toBeUndefined()
    expect((createAdminClient as any).mock.results[0].value.queryCount['rpc:rpc_create_wholesale_order']).toBe(1)
  })

  it('abaixo do mínimo → 422 estruturado (minimumOrder/currentTotal/missingAmount) e nada é gravado', async () => {
    setup(BASE, { minimum: 300 })
    const r = await createWholesaleOrder(input({ items: [{ variationId: 10, quantity: 6 }] })) // 6 × 39,90 = 239,40
    expect(r).toMatchObject({ ok: false, status: 422, error: 'below_minimum', minimumOrder: 300, currentTotal: 239.4, missingAmount: 60.6 })
    expect(tables.wholesale_orders).toHaveLength(0)
  })

  it.each([
    ['produto fora do atacado', { enabled: false }],
    ['produto inativo', { productActive: false }],
    ['variação inativa', { active: false }],
    ['sem preço de atacado', { price: null }],
    ['sem estoque', { stock: 0 }],
    ['produto de outra empresa', { company: OTHER }],
  ] as [string, Partial<V>][])('%s → 409 items_unavailable e nada é gravado', async (_name, over) => {
    setup([{ id: 10, product: 1, sku: 'X', ...over }])
    const r = await createWholesaleOrder(input())
    expect(r).toMatchObject({ ok: false, status: 409, error: 'items_unavailable' })
    expect(tables.wholesale_orders).toHaveLength(0)
    expect(tables.wholesale_order_counters).toHaveLength(0)
  })

  it('quantidade maior que o estoque → rejeita informando o disponível (não cria pedido diferente do solicitado)', async () => {
    setup([{ id: 10, product: 1, sku: 'X', stock: 3 }])
    const r = await createWholesaleOrder(input({ items: [{ variationId: 10, quantity: 5 }] }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(409)
    expect(r.validation?.items[0]).toMatchObject({ ok: false, reason: 'insufficient_stock', availableQuantity: 3 })
    expect(tables.wholesale_orders).toHaveLength(0)
  })

  it('WhatsApp da empresa não configurado → 503 e nada é gravado', async () => {
    setup(BASE)
    const r = await createWholesaleOrder(input({ settings: { whatsappPhone: null } }))
    expect(r).toMatchObject({ ok: false, status: 503, error: 'whatsapp_not_configured' })
    expect(tables.wholesale_orders).toHaveLength(0)
  })

  it('valida os dados do comprador (nome e telefone) sem criar customer', async () => {
    setup(BASE)
    expect(await createWholesaleOrder(input({ customer: { name: ' ', phone: '84999999999' } }))).toMatchObject({ ok: false, status: 422, error: 'invalid_customer' })
    expect(await createWholesaleOrder(input({ customer: { name: 'Ana', phone: '123' } }))).toMatchObject({ ok: false, status: 422, error: 'invalid_customer' })
    expect(tables.wholesale_orders).toHaveLength(0)
    expect(tables.customers).toBeUndefined()
  })

  it('telefone do comprador é normalizado (E.164) e o nome tem espaços colapsados', async () => {
    setup(BASE)
    const r = await createWholesaleOrder(input({ customer: { name: '  João   da  Silva ', phone: '84 98888-7777' } }))
    expect(r.ok && r.order).toMatchObject({ customerName: 'João da Silva', customerPhone: '+5584988887777' })
    expect(normalizeCustomerName('A')).toBeNull()
  })

  it('mesma variação repetida vira uma linha só, com quantidades somadas', async () => {
    setup(BASE)
    const r = await createWholesaleOrder(input({ items: [{ variationId: 10, quantity: 2 }, { variationId: 10, quantity: 3 }] }))
    expect(r.ok && r.order.items).toHaveLength(1)
    expect(r.ok && r.order.items[0].quantity).toBe(5)
  })
})

describe('createWholesaleOrder — preço/nome/SKU só do servidor', () => {
  it('o input do serviço só tem id+quantidade: preço adulterado é ignorado, vale o preço do banco', async () => {
    setup(BASE)
    const dirty = { variationId: 10, quantity: 3, unitPrice: 0.01, price: 0.01, productName: 'HACK', sku: 'HACK', subtotal: 0.03 } as any
    const r = await createWholesaleOrder(input({ items: [dirty] }))
    expect(r.ok && r.order.items[0]).toMatchObject({ unitPrice: 39.9, productName: 'Produto 1', sku: 'NUA-M-PRETO', subtotal: 119.7 })
  })
})

describe('snapshot comercial', () => {
  it('pedido mantém nome/SKU/atributos/preço originais depois de alterar o produto', async () => {
    setup(BASE)
    const created = await createWholesaleOrder(input())
    expect(created.ok).toBe(true)
    // Alterações posteriores no cadastro
    tables.products[0].name = 'Nome Novo'
    tables.products[0].wholesale_price = 99
    tables.product_variations[0].sku_variation = 'SKU-NOVO'
    tables.product_variation_attributes[0].variation_value_id = 3

    const order = await getWholesaleOrder(createAdminClient() as any, COMPANY, (created as any).order.id)
    expect(order?.items[0]).toMatchObject({ productName: 'Produto 1', sku: 'NUA-M-PRETO', unitPrice: 39.9, subtotal: 119.7 })
    expect(order?.items[0].attributes).toEqual([{ type: 'Tamanho', value: 'M' }, { type: 'Cor', value: 'Preto' }])
    expect(order?.subtotal).toBe(119.7)
  })
})

describe('idempotência', () => {
  it('mesma chave duas vezes → um único pedido; o retry devolve o mesmo pedido', async () => {
    setup(BASE)
    const first = await createWholesaleOrder(input())
    const second = await createWholesaleOrder(input())
    expect(tables.wholesale_orders).toHaveLength(1)
    expect(first.ok && second.ok && second.replay).toBe(true)
    expect(first.ok && second.ok && second.order.code).toBe((first as any).order.code)
    expect(first.ok && second.ok && second.order.id).toBe((first as any).order.id)
  })

  it('retry não revalida nem cria outro pedido mesmo se o estoque acabou depois', async () => {
    setup(BASE)
    await createWholesaleOrder(input())
    tables.stock_balances[0].quantity = 0
    const retry = await createWholesaleOrder(input())
    expect(retry).toMatchObject({ ok: true, replay: true })
    expect(tables.wholesale_orders).toHaveLength(1)
  })

  it('chaves diferentes criam pedidos distintos, com códigos sequenciais', async () => {
    setup(BASE)
    const a = await createWholesaleOrder(input({ idempotencyKey: KEY_A }))
    const b = await createWholesaleOrder(input({ idempotencyKey: KEY_B }))
    expect(tables.wholesale_orders).toHaveLength(2)
    expect([a, b].map((r) => r.ok && r.order.code)).toEqual(['AT-000001', 'AT-000002'])
  })

  it('a mesma chave em outra empresa não colide (idempotência é por empresa)', async () => {
    setup([...BASE, { id: 20, product: 2, sku: 'Y', company: OTHER }])
    await createWholesaleOrder(input())
    const other = await createWholesaleOrder(input({ companyId: OTHER, items: [{ variationId: 20, quantity: 3 }] }))
    expect(other).toMatchObject({ ok: true, replay: false })
    expect(other.ok && other.order.code).toBe('AT-000001') // contador por empresa
  })
})

describe('totais', () => {
  it('subtotal por item, total de peças e total em centavos exatos', async () => {
    setup([
      { id: 10, product: 1, sku: 'A', price: 19.99 },
      { id: 11, product: 2, sku: 'B', price: 0.1 },
      { id: 12, product: 3, sku: 'C', price: 0.2 },
    ], { minimum: 0 })
    const r = await createWholesaleOrder(input({ items: [{ variationId: 10, quantity: 3 }, { variationId: 11, quantity: 1 }, { variationId: 12, quantity: 1 }] }))
    expect(r.ok && r.order.items.map((i) => i.subtotal)).toEqual([59.97, 0.1, 0.2])
    expect(r.ok && r.order.totalItems).toBe(5)
    expect(r.ok && r.order.subtotal).toBe(60.27) // 59,97 + 0,10 + 0,20 sem erro de ponto flutuante
  })

  it('pedido exatamente no mínimo é aceito', async () => {
    setup([{ id: 10, product: 1, sku: 'A', price: 50 }], { minimum: 300 })
    expect((await createWholesaleOrder(input({ items: [{ variationId: 10, quantity: 6 }] }))).ok).toBe(true)
  })

  it('o mínimo do momento fica gravado no pedido', async () => {
    setup(BASE, { minimum: 100 })
    const r = await createWholesaleOrder(input())
    expect(r.ok && r.order.minimumOrderAmount).toBe(100)
  })
})

describe('transação e limites', () => {
  it('falha ao gravar um item → erro 500 e nenhum pedido/itens/contador parcial', async () => {
    setup([{ id: 10, product: 1, sku: 'A' }, { id: 11, product: 2, sku: 'B' }], { failOnItemIndex: 1 })
    const r = await createWholesaleOrder(input({ items: [{ variationId: 10, quantity: 3 }, { variationId: 11, quantity: 3 }] }))
    expect(r).toMatchObject({ ok: false, status: 500, error: 'create_failed' })
    expect(tables.wholesale_orders).toHaveLength(0)
    expect(tables.wholesale_order_items).toHaveLength(0)
    expect(tables.wholesale_order_counters).toHaveLength(0)
  })

  it('limite anti-spam (por telefone) → 429', async () => {
    setup(BASE)
    let last: any
    for (let i = 0; i < 11; i++) last = await createWholesaleOrder(input({ idempotencyKey: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }))
    expect(last).toMatchObject({ ok: false, status: 429, error: 'rate_limited' })
    expect(tables.wholesale_orders).toHaveLength(10)
  })

  it('teto global por empresa (não depende de IP/telefone) → 429 mesmo com IPs e telefones diferentes', async () => {
    setup(BASE)
    const admin = createAdminClient() as any
    // Pré-carrega 200 pedidos "da última hora" de IPs/telefones distintos.
    for (let i = 0; i < 200; i++) tables.wholesale_orders.push({ id: `x${i}`, company_id: COMPANY, idempotency_key: `k${i}`, request_ip_hash: `ip${i}`, customer_phone: `+55849${String(i).padStart(8, '0')}` })
    expect(admin).toBeDefined()
    const r = await createWholesaleOrder(input({ clientIp: '198.51.100.77', customer: { name: 'Novo Cliente', phone: '84977776666' } }))
    expect(r).toMatchObject({ ok: false, status: 429, error: 'rate_limited' })
  })

  it('falha do RPC é logada SEM dados pessoais (sem nome/telefone)', async () => {
    setup(BASE, { failOnItemIndex: 0 })
    const { logError } = await import('@/lib/errors/log')
    await createWholesaleOrder(input())
    const logged = JSON.stringify((logError as any).mock.calls)
    expect(logged).toContain('wholesale.createOrder (rpc)')
    expect(logged).toContain(KEY_A)
    expect(logged).not.toMatch(/Maria|9999|5584999999999/)
  })

  it('só o HMAC do IP é gravado, nunca o IP cru', async () => {
    setup(BASE)
    await createWholesaleOrder(input({ clientIp: '203.0.113.5' }))
    expect(tables.wholesale_orders[0].request_ip_hash).toBe(hashRequestIp('203.0.113.5'))
    expect(JSON.stringify(tables.wholesale_orders)).not.toContain('203.0.113.5')
    expect(hashRequestIp(null)).toBeNull()
  })

  it('carrinho grande demais é rejeitado antes de consultar o banco', async () => {
    setup(BASE)
    const r = await createWholesaleOrder(input({ items: [{ variationId: 10, quantity: 10001 }] }))
    expect(r).toMatchObject({ ok: false, status: 422 })
  })
})

describe('isolamento por empresa (leitura administrativa)', () => {
  async function twoCompanies() {
    setup([{ id: 10, product: 1, sku: 'A' }, { id: 20, product: 2, sku: 'B', company: OTHER }])
    const a = await createWholesaleOrder(input())
    const b = await createWholesaleOrder(input({ companyId: OTHER, idempotencyKey: KEY_B, items: [{ variationId: 20, quantity: 3 }] }))
    return { a: (a as any).order, b: (b as any).order }
  }

  it('lista: empresa A só vê os pedidos da empresa A, mais recentes primeiro', async () => {
    const { a } = await twoCompanies()
    const admin = createAdminClient() as any
    const list = await listWholesaleOrders(admin, COMPANY, {})
    expect(list.orders.map((o) => o.code)).toEqual([a.code])
    expect(list.total).toBe(1)
    const otherList = await listWholesaleOrders(admin, OTHER, {})
    expect(otherList.orders).toHaveLength(1)
    expect(otherList.orders[0].id).not.toBe(a.id)
  })

  it('detalhe: pedido da empresa B é "não encontrado" para a empresa A', async () => {
    const { a, b } = await twoCompanies()
    const admin = createAdminClient() as any
    expect(await getWholesaleOrder(admin, COMPANY, b.id)).toBeNull()
    expect(await getWholesaleOrder(admin, COMPANY, a.id)).toMatchObject({ code: a.code })
  })

  it('troca de status: só na própria empresa; nunca altera estoque nem cria venda', async () => {
    const { a, b } = await twoCompanies()
    const admin = createAdminClient() as any
    expect(await updateWholesaleOrderStatus(admin, COMPANY, b.id, 'cancelled')).toBe(false)
    expect(tables.wholesale_orders.find((o) => o.id === b.id)!.status).toBe('pending')
    expect(await updateWholesaleOrderStatus(admin, COMPANY, a.id, 'finalized')).toBe(true)
    expect(tables.wholesale_orders.find((o) => o.id === a.id)).toMatchObject({ status: 'finalized', sale_id: null })
    expect(tables.stock_balances.every((s) => s.quantity === 50)).toBe(true)
  })

  it('busca por código/nome/telefone e filtro por status', async () => {
    setup(BASE)
    await createWholesaleOrder(input({ idempotencyKey: KEY_A, customer: { name: 'Maria Silva', phone: '84999999999' } }))
    await createWholesaleOrder(input({ idempotencyKey: KEY_B, customer: { name: 'João Souza', phone: '84988887777' } }))
    const admin = createAdminClient() as any
    expect((await listWholesaleOrders(admin, COMPANY, { search: 'joão' })).orders.map((o) => o.customerName)).toEqual(['João Souza'])
    expect((await listWholesaleOrders(admin, COMPANY, { search: 'AT-000001' })).orders).toHaveLength(1)
    await updateWholesaleOrderStatus(admin, COMPANY, tables.wholesale_orders[0].id, 'cancelled')
    expect((await listWholesaleOrders(admin, COMPANY, { status: 'cancelled' })).orders).toHaveLength(1)
  })
})
