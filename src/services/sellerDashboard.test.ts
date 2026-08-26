import { describe, it, expect, vi, afterEach } from 'vitest'
import { getSellerReport } from './sellerDashboard'
import { createAdminClient } from '@/lib/supabase/admin'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

/** Chain genérica — qualquer método encadeável devolve a si mesma; resolve com as linhas fornecidas ao `await`/`.then`. Não valida os filtros aplicados (isso é responsabilidade do Postgres/PostgREST real) — só a lógica de agregação em JS, dado um retorno plausível. */
function fakeChain(rows: unknown[]) {
  const chain: any = {}
  for (const m of ['select', 'eq', 'gte', 'lte', 'in', 'order']) chain[m] = () => chain
  chain.then = (resolve: any) => resolve({ data: rows, error: null })
  return chain
}

function mockTables(tables: {
  sellers?: unknown[]
  sales?: unknown[]
  sale_items?: unknown[]
  exchanges?: unknown[]
}) {
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: (table: string) => fakeChain((tables as any)[table] ?? []),
  })
}

const SELLERS = [{ id: 1, name: 'Ana' }, { id: 2, name: 'Bruno' }]

describe('getSellerReport — Analytics Varejo/Atacado', () => {
  afterEach(() => vi.restoreAllMocks())

  it('16. vendedor só retail — wholesale zerado', () => {
    mockTables({
      sellers: SELLERS,
      sales: [{ id: 10, responsible_seller_id: 1, total: 100, discount_amount: 0, payment_method: 'pix', sale_origin: 'store', sale_type: 'retail', customer_id: 1, status: 'paid' }],
      sale_items: [{ sale_id: 10, quantity: 1, total_price: 100, gross_profit: 40, product_variations: { product_id: 1, products: { id: 1, name: 'P1', categories: null } } }],
      exchanges: [],
    })
    return getSellerReport(1, '2026-09-01', '2026-09-30').then(({ rows }) => {
      const ana = rows.find(r => r.sellerId === 1)!
      expect(ana.retail.revenue).toBe(100)
      expect(ana.wholesale.revenue).toBe(0)
      expect(ana.revenue).toBe(100) // total continua igual ao já existente
    })
  })

  it('17. vendedor só wholesale', async () => {
    mockTables({
      sellers: SELLERS,
      sales: [{ id: 11, responsible_seller_id: 1, total: 1000, discount_amount: 0, payment_method: 'pix', sale_origin: 'store', sale_type: 'wholesale', customer_id: 1, status: 'paid' }],
      sale_items: [{ sale_id: 11, quantity: 5, total_price: 1000, gross_profit: 200, product_variations: { product_id: 1, products: { id: 1, name: 'P1', categories: null } } }],
      exchanges: [],
    })
    const { rows } = await getSellerReport(1, '2026-09-01', '2026-09-30')
    const ana = rows.find(r => r.sellerId === 1)!
    expect(ana.wholesale.revenue).toBe(1000)
    expect(ana.retail.revenue).toBe(0)
  })

  it('18. vendedor misto — retail + wholesale, total soma os dois', async () => {
    mockTables({
      sellers: SELLERS,
      sales: [
        { id: 12, responsible_seller_id: 1, total: 100, discount_amount: 0, payment_method: 'pix', sale_origin: 'store', sale_type: 'retail', customer_id: 1, status: 'paid' },
        { id: 13, responsible_seller_id: 1, total: 900, discount_amount: 0, payment_method: 'pix', sale_origin: 'store', sale_type: 'wholesale', customer_id: 2, status: 'paid' },
      ],
      sale_items: [
        { sale_id: 12, quantity: 1, total_price: 100, gross_profit: 40, product_variations: { product_id: 1, products: { id: 1, name: 'P1', categories: null } } },
        { sale_id: 13, quantity: 9, total_price: 900, gross_profit: 180, product_variations: { product_id: 1, products: { id: 1, name: 'P1', categories: null } } },
      ],
      exchanges: [],
    })
    const { rows } = await getSellerReport(1, '2026-09-01', '2026-09-30')
    const ana = rows.find(r => r.sellerId === 1)!
    expect(ana.retail.revenue).toBe(100)
    expect(ana.wholesale.revenue).toBe(900)
    expect(ana.revenue).toBe(1000)
  })

  it('19. vendas sem vendedor aparecem como "Sem vendedor", com retail/wholesale próprios', async () => {
    mockTables({
      sellers: SELLERS,
      sales: [{ id: 14, responsible_seller_id: null, total: 50, discount_amount: 0, payment_method: 'pix', sale_origin: 'store', sale_type: 'retail', customer_id: null, status: 'paid' }],
      sale_items: [],
      exchanges: [],
    })
    const { rows } = await getSellerReport(1, '2026-09-01', '2026-09-30')
    const none = rows.find(r => r.sellerId === null)!
    expect(none).toBeDefined()
    expect(none.sellerName).toBe('Sem vendedor')
    expect(none.retail.revenue).toBe(50)
    expect(none.wholesale.revenue).toBe(0)
  })

  it('venda cancelada não entra em nenhuma modalidade, só incrementa cancellations', async () => {
    mockTables({
      sellers: SELLERS,
      sales: [{ id: 15, responsible_seller_id: 1, total: 500, discount_amount: 0, payment_method: 'pix', sale_origin: 'store', sale_type: 'wholesale', customer_id: 1, status: 'cancelled' }],
      sale_items: [],
      exchanges: [],
    })
    const { rows } = await getSellerReport(1, '2026-09-01', '2026-09-30')
    const ana = rows.find(r => r.sellerId === 1)!
    expect(ana.cancellations).toBe(1)
    expect(ana.wholesale.revenue).toBe(0)
    expect(ana.revenue).toBe(0)
  })
})
