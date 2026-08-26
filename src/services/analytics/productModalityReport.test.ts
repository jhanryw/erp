import { describe, it, expect, vi, afterEach } from 'vitest'
import { getProductModalityBreakdown } from './productModalityReport'
import { createAdminClient } from '@/lib/supabase/admin'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

function fakeChain(rows: unknown[], applied?: { eq: [string, unknown][] }) {
  const chain: any = {}
  for (const m of ['select', 'gte', 'lte', 'not', 'in', 'order']) chain[m] = () => chain
  chain.eq = (col: string, val: unknown) => { applied?.eq.push([col, val]); return chain }
  chain.then = (resolve: any) => resolve({ data: rows, error: null })
  return chain
}

function mockTables(sales: unknown[], saleItems: unknown[]) {
  const salesApplied = { eq: [] as [string, unknown][] }
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: (table: string) => {
      if (table === 'sales') return fakeChain(sales, salesApplied)
      if (table === 'sale_items') return fakeChain(saleItems)
      throw new Error(`unexpected table ${table}`)
    },
  })
  return salesApplied
}

describe('getProductModalityBreakdown', () => {
  afterEach(() => vi.restoreAllMocks())

  it('29. agrega unidades/receita/CMV/lucro/margem por produto', async () => {
    mockTables(
      [{ id: 1 }],
      [{ quantity: 3, total_price: 150, gross_profit: 60, product_variations: { product_id: 1, products: { id: 1, name: 'Camisola', company_id: 1 } } }],
    )
    const rows = await getProductModalityBreakdown(1, '2026-09-01', '2026-09-30')
    expect(rows).toEqual([{ product_id: 1, product_name: 'Camisola', unitsSold: 3, revenue: 150, cmv: 90, grossProfit: 60, marginPct: 40 }])
  })

  it('30/31. usa total_price/gross_profit REALIZADOS do item — nunca preço atual de catálogo (nenhuma leitura de products.base_price)', async () => {
    mockTables(
      [{ id: 1 }],
      [{ quantity: 1, total_price: 39.9, gross_profit: 10, product_variations: { product_id: 1, products: { id: 1, name: 'P', company_id: 1 } } }],
    )
    const rows = await getProductModalityBreakdown(1, '2026-09-01', '2026-09-30')
    expect(rows[0].revenue).toBe(39.9) // preço realizado da venda, não um preço atual buscado à parte
  })

  it('filtra por sale_type quando informado', async () => {
    const applied = mockTables([], [])
    await getProductModalityBreakdown(1, '2026-09-01', '2026-09-30', 'wholesale')
    expect(applied.eq).toContainEqual(['sale_type', 'wholesale'])
  })

  it('sem vendas no período → array vazio, nunca erro (nem chama sale_items)', async () => {
    mockTables([], [])
    const rows = await getProductModalityBreakdown(1, '2026-09-01', '2026-09-30')
    expect(rows).toEqual([])
  })

  it('sempre filtra por company_id', async () => {
    const applied = mockTables([], [])
    await getProductModalityBreakdown(9, '2026-09-01', '2026-09-30')
    expect(applied.eq).toContainEqual(['company_id', 9])
  })
})
