// Correção 2026-09-15 — troca com venda-filha não dispara mais o push
// genérico "Nova venda" (que mostrava "R$0,00" numa troca sem diferença,
// semanticamente enganoso). notifyExchange() é o disparo dedicado,
// chamado por troca/route.ts no lugar de createSale()->notifyNewSale().
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { notifyExchange } from './exchange'
import { createAdminClient } from '@/lib/supabase/admin'
import * as todayRevenueModule from '@/lib/analytics/todayRevenue'
import * as sendModule from '@/lib/push/send'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

// Intl.NumberFormat('pt-BR', {style:'currency',...}) usa espaço não-quebrável
// (U+00A0) entre "R$" e o valor — formata aqui em vez de hardcodear a
// string, pra não depender desse detalhe de encoding no teste.
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

function mockAdmin({ claimed }: { claimed: boolean }) {
  const upsertSpy = vi.fn().mockReturnValue({
    select: () => Promise.resolve({ data: claimed ? [{ sale_id: 822 }] : [], error: null }),
  })
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: (table: string) => {
      if (table === 'sale_push_notifications') {
        return { upsert: upsertSpy }
      }
      throw new Error(`tabela inesperada no mock: ${table}`)
    },
  })
  return { upsertSpy }
}

describe('notifyExchange — push dedicado de troca (src/lib/push/exchange.ts)', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('sem diferença (difference=0) — corpo diz "Sem diferença a pagar", nunca "R$0,00" genérico', async () => {
    mockAdmin({ claimed: true })
    vi.spyOn(todayRevenueModule, 'getTodayRevenue').mockResolvedValue({ revenue: 1009.70, orders: 8, avgTicket: 126.21 })
    const sendSpy = vi.spyOn(sendModule, 'sendPushNotification').mockResolvedValue(undefined as any)

    await notifyExchange({ saleId: 822, companyId: 1, difference: 0 })

    expect(sendSpy).toHaveBeenCalledWith({
      companyId: 1,
      roles: ['admin'],
      title: 'Troca realizada • Santtorini',
      body: `Sem diferença a pagar • Faturamento hoje: ${currency.format(1009.70)}`,
      url: '/vendas/822',
    })
  })

  it('com diferença (difference=10) — corpo mostra o valor cobrado', async () => {
    mockAdmin({ claimed: true })
    vi.spyOn(todayRevenueModule, 'getTodayRevenue').mockResolvedValue({ revenue: 1039.69, orders: 8, avgTicket: 129.96 })
    const sendSpy = vi.spyOn(sendModule, 'sendPushNotification').mockResolvedValue(undefined as any)

    await notifyExchange({ saleId: 709, companyId: 1, difference: 10 })

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Troca realizada • Santtorini',
      body: `Diferença: ${currency.format(10)} • Faturamento hoje: ${currency.format(1039.69)}`,
    }))
  })

  it('faturamento vem exclusivamente de getTodayRevenue — nenhum cálculo paralelo', async () => {
    mockAdmin({ claimed: true })
    const revenueSpy = vi.spyOn(todayRevenueModule, 'getTodayRevenue').mockResolvedValue({ revenue: 500, orders: 3, avgTicket: 166.67 })
    vi.spyOn(sendModule, 'sendPushNotification').mockResolvedValue(undefined as any)

    await notifyExchange({ saleId: 1, companyId: 7, difference: 0 })

    expect(revenueSpy).toHaveBeenCalledWith(7)
    expect(revenueSpy).toHaveBeenCalledTimes(1)
  })

  it('idempotência: claim já existente (linha já reclamada) → não reenvia push', async () => {
    mockAdmin({ claimed: false })
    const revenueSpy = vi.spyOn(todayRevenueModule, 'getTodayRevenue')
    const sendSpy = vi.spyOn(sendModule, 'sendPushNotification').mockResolvedValue(undefined as any)

    await notifyExchange({ saleId: 822, companyId: 1, difference: 0 })

    expect(sendSpy).not.toHaveBeenCalled()
    expect(revenueSpy).not.toHaveBeenCalled()
  })

  it('claim com erro no banco → não lança, não envia push', async () => {
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      from: () => ({
        upsert: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }),
      }),
    })
    const sendSpy = vi.spyOn(sendModule, 'sendPushNotification').mockResolvedValue(undefined as any)

    await expect(notifyExchange({ saleId: 822, companyId: 1, difference: 0 })).resolves.toBeUndefined()
    expect(sendSpy).not.toHaveBeenCalled()
  })
})
