// Kits (2026-09-23) — integração de kit nas pré-validações de venda:
//   - validateStockForSale: kit usa disponibilidade DERIVADA (camada central),
//     produto normal segue a checagem de saldo de sempre.
//   - resolveAuthoritativeItemCosts: custo do kit = soma dos componentes
//     (nunca base_cost=0 do produto-kit, nunca o unit_cost do payload).
// A decisão final (lock + baixa) é da RPC — coberta em supabase/tests/.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { validateStockForSale, resolveAuthoritativeItemCosts, type SaleItem } from './vendas.service'
import * as availability from './inventory/availability.service'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('./inventory/availability.service', () => ({
  findKitVariationIds: vi.fn(),
  getVariationAvailability: vi.fn(),
  getKitUnitCosts: vi.fn(),
}))

const COMPANY = 1
const STD = 1
const KIT = 10

const item = (pvid: number, quantity: number, unit_cost = 0): SaleItem => ({
  product_variation_id: pvid, quantity, unit_price: 50, unit_cost, discount_amount: 0, surcharge_amount: 0,
})

function mockAdmin(balances: Record<number, number>) {
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: (table: string) => {
      if (table === 'product_variations') {
        return {
          select: () => ({
            in: (_col: string, ids: number[]) => Promise.resolve({
              data: ids.map((id) => ({ id, cost_override: id === STD ? 12 : null, products: { company_id: COMPANY, base_cost: 0 } })),
              error: null,
            }),
          }),
        }
      }
      if (table === 'stock_balances') {
        return {
          select: () => ({
            eq: (_c: string, pvid: number) => Promise.resolve({ data: [{ quantity: balances[pvid] ?? 0 }], error: null }),
          }),
        }
      }
      throw new Error(`tabela inesperada: ${table}`)
    },
  })
}

const mocked = availability as unknown as {
  findKitVariationIds: ReturnType<typeof vi.fn>
  getVariationAvailability: ReturnType<typeof vi.fn>
  getKitUnitCosts: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.clearAllMocks()
  mocked.findKitVariationIds.mockResolvedValue({ ok: true, data: new Set([KIT]) })
  mocked.getVariationAvailability.mockResolvedValue({
    ok: true,
    data: new Map([[KIT, { product_variation_id: KIT, sellable_quantity: 7 }]]),
  })
  mocked.getKitUnitCosts.mockResolvedValue({ ok: true, data: new Map([[KIT, 28]]) })
})

describe('validateStockForSale com kit', () => {
  it('kit sem saldo físico, mas com 7 derivados, passa para 3 unidades', async () => {
    mockAdmin({ [STD]: 5 })
    const r = await validateStockForSale([item(KIT, 3), item(STD, 1)], COMPANY)
    expect(r.ok).toBe(true)
    expect(mocked.getVariationAvailability).toHaveBeenCalledWith(COMPANY, [KIT], 'main_store')
  })

  it('kit acima da disponibilidade derivada é bloqueado antes da RPC', async () => {
    mockAdmin({})
    const r = await validateStockForSale([item(KIT, 8)], COMPANY)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Kit #10 sem componentes suficientes/)
  })

  it('usa o mesmo modo de baixa da venda (online)', async () => {
    mockAdmin({})
    await validateStockForSale([item(KIT, 1)], COMPANY, 'online_priority')
    expect(mocked.getVariationAvailability).toHaveBeenCalledWith(COMPANY, [KIT], 'online_priority')
  })

  it('produto normal continua com a checagem de saldo de sempre', async () => {
    mocked.findKitVariationIds.mockResolvedValue({ ok: true, data: new Set() })
    mockAdmin({ [STD]: 1 })
    const r = await validateStockForSale([item(STD, 2)], COMPANY)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Estoque insuficiente para variação #1/)
    expect(mocked.getVariationAvailability).not.toHaveBeenCalled()
  })
})

describe('resolveAuthoritativeItemCosts com kit', () => {
  it('kit recebe custo derivado dos componentes; payload é ignorado', async () => {
    mockAdmin({})
    const r = await resolveAuthoritativeItemCosts([item(KIT, 1, 999), item(STD, 1, 0)], COMPANY)
    expect(r.ok && r.data.map((i) => i.unit_cost)).toEqual([28, 12])
  })
})
