import { describe, it, expect, vi, afterEach } from 'vitest'
import { getModalityComparison, getDailyModalityRevenue } from './modalityAnalytics'
import { createAdminClient } from '@/lib/supabase/admin'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

/** Query builder fake — encadeia métodos e resolve com `rows` no fim, gravando os filtros aplicados. */
function chainable(rows: unknown[]) {
  const applied: { eq: [string, unknown][]; gte?: string; lte?: string } = { eq: [] }
  const chain: any = {
    eq: (col: string, val: unknown) => { applied.eq.push([col, val]); return chain },
    gte: (col: string, val: unknown) => { applied.gte = val as string; return chain },
    lte: (col: string, val: unknown) => { applied.lte = val as string; return chain },
    not: () => chain,
    order: () => chain,
    then: (resolve: any) => resolve({ data: rows, error: null }),
  }
  return { chain, applied }
}

function mockSalesTable(rows: unknown[]) {
  const { chain, applied } = chainable(rows)
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: (table: string) => {
      if (table !== 'sales') throw new Error(`unexpected table ${table}`)
      return { select: () => chain }
    },
  })
  return applied
}

describe('getModalityComparison', () => {
  afterEach(() => vi.restoreAllMocks())

  it('agrega vendas retail/wholesale com itens, isolado por company_id', async () => {
    mockSalesTable([
      { id: 1, sale_type: 'retail', total: 100, sale_items: [{ gross_profit: 40, quantity: 2 }] },
      { id: 2, sale_type: 'wholesale', total: 900, sale_items: [{ gross_profit: 180, quantity: 9 }] },
    ])
    const result = await getModalityComparison(1, '2026-09-01', '2026-09-30')
    expect(result.retail.revenue).toBe(100)
    expect(result.wholesale.revenue).toBe(900)
    expect(result.total.revenue).toBe(1000)
  })

  it('sale_items pode vir como objeto único (não array) — normalizado igual', async () => {
    mockSalesTable([
      { id: 1, sale_type: 'retail', total: 50, sale_items: { gross_profit: 20, quantity: 1 } },
    ])
    const result = await getModalityComparison(1, '2026-09-01', '2026-09-30')
    expect(result.retail.grossProfit).toBe(20)
  })

  it('venda sem itens (sale_items: null) não quebra', async () => {
    mockSalesTable([{ id: 1, sale_type: 'retail', total: 50, sale_items: null }])
    const result = await getModalityComparison(1, '2026-09-01', '2026-09-30')
    expect(result.retail.revenue).toBe(50)
    expect(result.retail.grossProfit).toBe(0)
  })

  it('sale_type nulo/desconhecido cai em retail (defesa, nunca perde a venda)', async () => {
    mockSalesTable([{ id: 1, sale_type: null, total: 50, sale_items: null }])
    const result = await getModalityComparison(1, '2026-09-01', '2026-09-30')
    expect(result.retail.revenue).toBe(50)
  })

  it('sem nenhuma venda no período — tudo zerado, nunca erro', async () => {
    mockSalesTable([])
    const result = await getModalityComparison(1, '2026-09-01', '2026-09-30')
    expect(result.total.revenue).toBe(0)
  })

  it('filtra por sales_channel quando informado (cruzamento sale_type × canal)', async () => {
    const applied = mockSalesTable([])
    await getModalityComparison(1, '2026-09-01', '2026-09-30', { salesChannel: 'pos' })
    expect(applied.eq).toContainEqual(['sales_channel', 'pos'])
  })

  it('sempre filtra por company_id — nunca mistura tenants', async () => {
    const applied = mockSalesTable([])
    await getModalityComparison(7, '2026-09-01', '2026-09-30')
    expect(applied.eq).toContainEqual(['company_id', 7])
  })

  it('27. aplica o intervalo de período exatamente como recebido (gte/lte)', async () => {
    const applied = mockSalesTable([])
    await getModalityComparison(1, '2026-09-01', '2026-09-15')
    expect(applied.gte).toBe('2026-09-01')
    expect(applied.lte).toBe('2026-09-15')
  })
})

describe('getDailyModalityRevenue', () => {
  afterEach(() => vi.restoreAllMocks())

  it('agrupa por dia e modalidade em formato wide', async () => {
    mockSalesTable([
      { sale_date: '2026-09-01', sale_type: 'retail', total: 100 },
      { sale_date: '2026-09-01', sale_type: 'wholesale', total: 900 },
      { sale_date: '2026-09-02', sale_type: 'retail', total: 50 },
    ])
    const result = await getDailyModalityRevenue(1, '2026-09-01', '2026-09-30')
    expect(result).toEqual([
      { sale_date: '2026-09-01', retailRevenue: 100, wholesaleRevenue: 900, totalRevenue: 1000 },
      { sale_date: '2026-09-02', retailRevenue: 50, wholesaleRevenue: 0, totalRevenue: 50 },
    ])
  })

  it('período sem vendas — array vazio, nunca erro', async () => {
    mockSalesTable([])
    const result = await getDailyModalityRevenue(1, '2026-09-01', '2026-09-30')
    expect(result).toEqual([])
  })
})
