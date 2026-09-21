import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { createFakeAdmin, type FakeTables } from './fakeSupabase.testutil'
import { getWholesaleSiteSettings } from './settings'
import { revalidateWholesaleCart } from './cartValidation'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('./settings', () => ({ getWholesaleSiteSettings: vi.fn() }))

const setMinimum = (minimumOrderAmount: number) =>
  (getWholesaleSiteSettings as any).mockResolvedValue({ minimumOrderAmount })

const COMPANY = 1

interface Spec {
  id?: number
  company?: number
  productActive?: boolean
  enabled?: boolean
  productPrice?: number | null
  override?: number | null
  variationActive?: boolean
  stock?: number
}

function setup(spec: Spec | Spec[], options?: { maxRows?: number }) {
  const specs = Array.isArray(spec) ? spec : [spec]
  const tables: FakeTables = {
    products: [], product_variations: [], stock_balances: [],
    stock_locations: [{ id: 1, company_id: COMPANY, active: true }, { id: 2, company_id: 2, active: true }],
  }
  specs.forEach((s, i) => {
    const id = s.id ?? 10 + i
    tables.products.push({
      id, company_id: s.company ?? COMPANY, active: s.productActive ?? true, wholesale_enabled: s.enabled ?? true,
      wholesale_price: s.productPrice === undefined ? 20 : s.productPrice,
    })
    tables.product_variations.push({ id, product_id: id, active: s.variationActive ?? true, wholesale_price_override: s.override ?? null })
    tables.stock_balances.push({ product_variation_id: id, stock_location_id: (s.company ?? COMPANY) === COMPANY ? 1 : 2, quantity: s.stock ?? 5 })
  })
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(createFakeAdmin(tables, options))
}

beforeEach(() => { vi.resetAllMocks(); setMinimum(300) })

describe('revalidateWholesaleCart', () => {
  it('carrinho vazio é válido sem consultar o banco', async () => {
    expect(await revalidateWholesaleCart(COMPANY, [])).toMatchObject({ valid: true, items: [] })
    expect(createAdminClient).toHaveBeenCalledTimes(0) // nem cria client — sem consulta
  })

  it('item ok — preço do servidor e estoque suficiente', async () => {
    setup({ id: 10 })
    const result = await revalidateWholesaleCart(COMPANY, [{ variationId: 10, quantity: 3 }])
    expect(result).toMatchObject({ valid: true, items: [{ variationId: 10, ok: true, price: 20, availableQuantity: 5 }] })
    expect(result.summary).toMatchObject({ subtotal: 60 })
  })

  it('11. usa o preço ATUAL do servidor (override da variação > preço do produto)', async () => {
    setup([{ id: 10, productPrice: 20 }, { id: 11, productPrice: 20, override: 17.5 }])
    const result = await revalidateWholesaleCart(COMPANY, [{ variationId: 10, quantity: 1 }, { variationId: 11, quantity: 1 }])
    expect(result.items.map((i) => (i.ok ? i.price : null))).toEqual([20, 17.5])
  })

  it('10. item cujo produto deixou de estar habilitado no atacado é rejeitado', async () => {
    setup({ id: 10, enabled: false })
    const result = await revalidateWholesaleCart(COMPANY, [{ variationId: 10, quantity: 1 }])
    expect(result.valid).toBe(false)
    expect(result.items[0]).toMatchObject({ ok: false, reason: 'not_enabled' })
  })

  it('variação de outra empresa — not_found (nunca vaza dado entre empresas)', async () => {
    setup({ id: 10, company: 2 })
    const result = await revalidateWholesaleCart(COMPANY, [{ variationId: 10, quantity: 1 }])
    expect(result.items[0]).toMatchObject({ ok: false, reason: 'not_found', availableQuantity: 0 })
  })

  it('variação inexistente — not_found', async () => {
    setup({ id: 10 })
    expect((await revalidateWholesaleCart(COMPANY, [{ variationId: 999, quantity: 1 }])).items[0]).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('variação ou produto inativo — inactive', async () => {
    setup([{ id: 10, variationActive: false }, { id: 11, productActive: false }])
    const result = await revalidateWholesaleCart(COMPANY, [{ variationId: 10, quantity: 1 }, { variationId: 11, quantity: 1 }])
    expect(result.items.map((i) => (i.ok ? 'ok' : i.reason))).toEqual(['inactive', 'inactive'])
  })

  it('sem preço de atacado — no_wholesale_price (habilitado no canal não basta)', async () => {
    setup({ id: 10, productPrice: null })
    expect((await revalidateWholesaleCart(COMPANY, [{ variationId: 10, quantity: 1 }])).items[0]).toMatchObject({ ok: false, reason: 'no_wholesale_price' })
  })

  it('12. quantidade acima do estoque — insufficient_stock com a quantidade disponível', async () => {
    setup({ id: 10, stock: 2 })
    const result = await revalidateWholesaleCart(COMPANY, [{ variationId: 10, quantity: 3 }])
    expect(result.items[0]).toMatchObject({ ok: false, reason: 'insufficient_stock', availableQuantity: 2, price: 20 })
  })

  it('estoque zero — insufficient_stock com 0 disponível', async () => {
    setup({ id: 10, stock: 0 })
    expect((await revalidateWholesaleCart(COMPANY, [{ variationId: 10, quantity: 1 }])).items[0]).toMatchObject({ ok: false, reason: 'insufficient_stock', availableQuantity: 0 })
  })

  it('13. carrinho com mais de 1000 itens não é truncado (maxRows=1000 simulado)', async () => {
    const specs: Spec[] = Array.from({ length: 1100 }, (_, i) => ({ id: i + 1 }))
    setup(specs, { maxRows: 1000 })
    const result = await revalidateWholesaleCart(COMPANY, specs.map((s) => ({ variationId: s.id!, quantity: 1 })))
    expect(result.valid).toBe(true)
    expect(result.items).toHaveLength(1100)
  })

  it('não expõe estoque de item fora do atacado/inativo/sem preço (evita enumerar estoque de ids arbitrários)', async () => {
    setup([{ id: 10, enabled: false, stock: 9 }, { id: 11, productActive: false, stock: 9 }, { id: 12, productPrice: null, stock: 9 }, { id: 13, stock: 9 }])
    const result = await revalidateWholesaleCart(COMPANY, [10, 11, 12, 13].map((variationId) => ({ variationId, quantity: 1 })))
    expect(result.items.map((i) => i.availableQuantity)).toEqual([0, 0, 0, 9])
  })
})

describe('revalidateWholesaleCart — pedido mínimo calculado no servidor', () => {
  it('soma preço ATUAL × quantidade e informa o que falta para o mínimo', async () => {
    setMinimum(300)
    setup([{ id: 10, productPrice: 20, stock: 50 }, { id: 11, productPrice: 12.5, stock: 50 }])
    const { summary } = await revalidateWholesaleCart(COMPANY, [{ variationId: 10, quantity: 10 }, { variationId: 11, quantity: 3 }])
    expect(summary).toEqual({ subtotal: 237.5, minimumOrderAmount: 300, meetsMinimum: false, missingForMinimum: 62.5 })
  })

  it('atingiu o mínimo → meetsMinimum e nada falta', async () => {
    setMinimum(300)
    setup({ id: 10, productPrice: 30, stock: 50 })
    expect((await revalidateWholesaleCart(COMPANY, [{ variationId: 10, quantity: 10 }])).summary).toMatchObject({ subtotal: 300, meetsMinimum: true, missingForMinimum: 0 })
  })

  it('o mínimo vem da configuração da empresa (não é constante)', async () => {
    setMinimum(100)
    setup({ id: 10, productPrice: 30, stock: 50 })
    expect((await revalidateWholesaleCart(COMPANY, [{ variationId: 10, quantity: 4 }])).summary).toMatchObject({ minimumOrderAmount: 100, meetsMinimum: true })
  })

  it('o total ignora qualquer preço do navegador: a entrada só tem id e quantidade', async () => {
    setup({ id: 10, productPrice: 20, stock: 50 })
    const dirty = [{ variationId: 10, quantity: 2, price: 0.01, displayPrice: 0.01 }] as any
    const { summary, items } = await revalidateWholesaleCart(COMPANY, dirty)
    expect(summary.subtotal).toBe(40)
    expect(items[0]).toMatchObject({ price: 20 })
  })

  it('mínimo é recalculado quando o preço muda no servidor', async () => {
    setMinimum(300)
    const cart = [{ variationId: 10, quantity: 10 }]
    setup({ id: 10, productPrice: 30, stock: 50 })
    expect((await revalidateWholesaleCart(COMPANY, cart)).summary).toMatchObject({ subtotal: 300, meetsMinimum: true })

    setup({ id: 10, productPrice: 25, stock: 50 }) // preço caiu
    expect((await revalidateWholesaleCart(COMPANY, cart)).summary).toMatchObject({ subtotal: 250, meetsMinimum: false, missingForMinimum: 50 })
  })

  it('quantidade acima do estoque conta só o disponível; item sem estoque/desabilitado não conta', async () => {
    setMinimum(300)
    setup([{ id: 10, productPrice: 20, stock: 3 }, { id: 11, productPrice: 20, stock: 0 }, { id: 12, productPrice: 20, enabled: false, stock: 9 }])
    const { summary, valid } = await revalidateWholesaleCart(COMPANY, [10, 11, 12].map((variationId) => ({ variationId, quantity: 10 })))
    expect(valid).toBe(false)
    expect(summary.subtotal).toBe(60) // só as 3 un. disponíveis do item 10
  })
})
