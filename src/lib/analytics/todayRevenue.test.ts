import { describe, it, expect, vi, afterEach } from 'vitest'
import { getTodayRevenue } from './todayRevenue'
import { createAdminClient } from '@/lib/supabase/admin'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

function fakeChain(rows: unknown[]) {
  const chain: any = {}
  for (const m of ['select', 'eq', 'not']) chain[m] = () => chain
  chain.then = (resolve: any) => resolve({ data: rows, error: null })
  return chain
}

function mockSales(rows: unknown[]) {
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: () => fakeChain(rows),
  })
}

describe('getTodayRevenue — fonte única do "Faturamento Hoje" (Dashboard, resumo diário, push de nova venda)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('soma revenue, conta pedidos e calcula ticket médio', async () => {
    mockSales([{ id: 1, total: 100 }, { id: 2, total: 29.9 }])
    const result = await getTodayRevenue(1)
    expect(result.revenue).toBeCloseTo(129.9)
    expect(result.orders).toBe(2)
    expect(result.avgTicket).toBeCloseTo(64.95)
  })

  it('sem vendas hoje — tudo zerado, sem divisão por zero no ticket médio', async () => {
    mockSales([])
    const result = await getTodayRevenue(1)
    expect(result).toEqual({ revenue: 0, orders: 0, avgTicket: 0 })
  })

  it('total nulo/ausente em alguma linha não quebra a soma', async () => {
    mockSales([{ id: 1, total: 50 }, { id: 2, total: null }])
    const result = await getTodayRevenue(1)
    expect(result.revenue).toBe(50)
    expect(result.orders).toBe(2)
  })
})
