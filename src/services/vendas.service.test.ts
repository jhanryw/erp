// Correção 2026-09-15 — createSale() ganhou `skipNewSaleNotification` para
// a rota de troca poder disparar seu próprio push (notifyExchange) em vez
// do "Nova venda" genérico. Este teste cobre exclusivamente esse mecanismo
// — não re-testa toda a lógica de precificação/estoque de rpc_create_sale
// (isso é responsabilidade dos testes SQL em supabase/tests/).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSale } from './vendas.service'
import { createAdminClient } from '@/lib/supabase/admin'
import * as newSaleModule from '@/lib/push/newSale'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

const CUSTOMER_ID = 10
const SYSTEM_USER_ID = 'seller-uuid'
const COMPANY_ID = 1

function mockAdmin() {
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: (table: string) => {
      if (table === 'customers') {
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { is_anonymous: false }, error: null }) }) }) }
      }
      if (table === 'users') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { company_id: COMPANY_ID }, error: null }) }) }) }
      }
      throw new Error(`tabela inesperada no mock: ${table}`)
    },
    rpc: vi.fn().mockResolvedValue({
      data: { id: 822, sale_number: 'SNT-20260914-0009', total: 0 },
      error: null,
    }),
  })
}

const BASE_INPUT = {
  customer_id: CUSTOMER_ID,
  payment_method: 'pix' as const,
  discount_amount: 0,
  surcharge_amount: 0,
  cashback_used: 29.98,
  shipping_charged: 0,
  items: [{ product_variation_id: 1, quantity: 1, unit_price: 29.98, unit_cost: 0, discount_amount: 0, surcharge_amount: 0 }],
  systemUserId: SYSTEM_USER_ID,
  responsible_seller_id: null,
}

describe('createSale — skipNewSaleNotification (src/services/vendas.service.ts)', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('skipNewSaleNotification: true (fluxo de troca) — NUNCA chama notifyNewSale', async () => {
    mockAdmin()
    const notifySpy = vi.spyOn(newSaleModule, 'notifyNewSale').mockResolvedValue(undefined)

    const result = await createSale({ ...BASE_INPUT, skipNewSaleNotification: true })

    expect(result.ok).toBe(true)
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('skipNewSaleNotification ausente (PDV/Atacado normais) — continua chamando notifyNewSale', async () => {
    mockAdmin()
    const notifySpy = vi.spyOn(newSaleModule, 'notifyNewSale').mockResolvedValue(undefined)

    const result = await createSale({ ...BASE_INPUT })

    expect(result.ok).toBe(true)
    expect(notifySpy).toHaveBeenCalledWith({ saleId: 822, companyId: COMPANY_ID, total: 0 })
  })

  it('skipNewSaleNotification: false explícito — comportamento idêntico a ausente', async () => {
    mockAdmin()
    const notifySpy = vi.spyOn(newSaleModule, 'notifyNewSale').mockResolvedValue(undefined)

    await createSale({ ...BASE_INPUT, skipNewSaleNotification: false })

    expect(notifySpy).toHaveBeenCalledTimes(1)
  })
})
