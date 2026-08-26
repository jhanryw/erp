import { describe, it, expect, vi, afterEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { revalidateWholesaleCart } from './cartValidation'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

function fakeChain(rows: unknown[]) {
  const chain: any = {}
  for (const m of ['select', 'eq', 'in']) chain[m] = () => chain
  chain.then = (resolve: any) => resolve({ data: rows, error: null })
  return chain
}

function mockCart(variationRows: any[], stockRows: { product_variation_id: number; quantity: number }[]) {
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: (table: string) => {
      if (table === 'product_variations') return fakeChain(variationRows)
      if (table === 'stock_balances') return fakeChain(stockRows)
      return fakeChain([])
    },
  })
}

const COMPANY_ID = 1

describe('revalidateWholesaleCart', () => {
  afterEach(() => vi.restoreAllMocks())

  it('carrinho vazio é válido sem consultar o banco', async () => {
    mockCart([], [])
    const result = await revalidateWholesaleCart(COMPANY_ID, [])
    expect(result).toEqual({ valid: true, items: [] })
  })

  it('item ok — preço resolvido e estoque suficiente', async () => {
    mockCart(
      [{ id: 10, active: true, wholesale_price_override: null, products: { id: 1, company_id: COMPANY_ID, active: true, wholesale_price: 20 } }],
      [{ product_variation_id: 10, quantity: 5 }],
    )
    const result = await revalidateWholesaleCart(COMPANY_ID, [{ variationId: 10, quantity: 3 }])
    expect(result).toEqual({ valid: true, items: [{ variationId: 10, ok: true, price: 20, availableQuantity: 5 }] })
  })

  it('variação de outra empresa — not_found (nunca vaza dado entre empresas)', async () => {
    mockCart(
      [{ id: 10, active: true, wholesale_price_override: null, products: { id: 1, company_id: 999, active: true, wholesale_price: 20 } }],
      [{ product_variation_id: 10, quantity: 5 }],
    )
    const result = await revalidateWholesaleCart(COMPANY_ID, [{ variationId: 10, quantity: 1 }])
    expect(result.valid).toBe(false)
    expect(result.items[0]).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('variação/produto inativo — inactive', async () => {
    mockCart(
      [{ id: 10, active: false, wholesale_price_override: null, products: { id: 1, company_id: COMPANY_ID, active: true, wholesale_price: 20 } }],
      [{ product_variation_id: 10, quantity: 5 }],
    )
    const result = await revalidateWholesaleCart(COMPANY_ID, [{ variationId: 10, quantity: 1 }])
    expect(result.items[0]).toMatchObject({ ok: false, reason: 'inactive' })
  })

  it('sem preço de atacado cadastrado — no_wholesale_price, nunca cai pro varejo', async () => {
    mockCart(
      [{ id: 10, active: true, wholesale_price_override: null, products: { id: 1, company_id: COMPANY_ID, active: true, wholesale_price: null } }],
      [{ product_variation_id: 10, quantity: 5 }],
    )
    const result = await revalidateWholesaleCart(COMPANY_ID, [{ variationId: 10, quantity: 1 }])
    expect(result.items[0]).toMatchObject({ ok: false, reason: 'no_wholesale_price' })
  })

  it('quantidade pedida maior que o estoque real — insufficient_stock com a quantidade disponível', async () => {
    mockCart(
      [{ id: 10, active: true, wholesale_price_override: null, products: { id: 1, company_id: COMPANY_ID, active: true, wholesale_price: 20 } }],
      [{ product_variation_id: 10, quantity: 2 }],
    )
    const result = await revalidateWholesaleCart(COMPANY_ID, [{ variationId: 10, quantity: 5 }])
    expect(result.items[0]).toMatchObject({ ok: false, reason: 'insufficient_stock', availableQuantity: 2, price: 20 })
  })

  it('estoque soma múltiplas stock_locations da mesma variação', async () => {
    mockCart(
      [{ id: 10, active: true, wholesale_price_override: null, products: { id: 1, company_id: COMPANY_ID, active: true, wholesale_price: 20 } }],
      [{ product_variation_id: 10, quantity: 2 }, { product_variation_id: 10, quantity: 3 }],
    )
    const result = await revalidateWholesaleCart(COMPANY_ID, [{ variationId: 10, quantity: 5 }])
    expect(result.items[0]).toMatchObject({ ok: true, availableQuantity: 5 })
  })

  it('um item inválido invalida o carrinho inteiro (valid=false) sem descartar os demais resultados', async () => {
    mockCart(
      [
        { id: 10, active: true, wholesale_price_override: null, products: { id: 1, company_id: COMPANY_ID, active: true, wholesale_price: 20 } },
        { id: 11, active: true, wholesale_price_override: null, products: { id: 1, company_id: COMPANY_ID, active: true, wholesale_price: null } },
      ],
      [{ product_variation_id: 10, quantity: 5 }, { product_variation_id: 11, quantity: 5 }],
    )
    const result = await revalidateWholesaleCart(COMPANY_ID, [{ variationId: 10, quantity: 1 }, { variationId: 11, quantity: 1 }])
    expect(result.valid).toBe(false)
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({ ok: true })
    expect(result.items[1]).toMatchObject({ ok: false, reason: 'no_wholesale_price' })
  })

  it('wholesale_price_override da variação tem prioridade sobre o preço do produto', async () => {
    mockCart(
      [{ id: 10, active: true, wholesale_price_override: 15, products: { id: 1, company_id: COMPANY_ID, active: true, wholesale_price: 20 } }],
      [{ product_variation_id: 10, quantity: 5 }],
    )
    const result = await revalidateWholesaleCart(COMPANY_ID, [{ variationId: 10, quantity: 1 }])
    expect(result.items[0]).toMatchObject({ ok: true, price: 15 })
  })
})
