import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { POST } from './route'
import { createAdminClient } from '@/lib/supabase/admin'
import * as todayRevenueModule from '@/lib/analytics/todayRevenue'
import * as sendModule from '@/lib/push/send'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

function buildRequest(secret: string | null) {
  return new Request('http://localhost/api/jobs/daily-sales-summary', {
    method:  'POST',
    headers: secret ? { Authorization: `Bearer ${secret}` } : {},
  })
}

function mockAdmin(subCompanies: { company_id: number }[], claimResult: unknown[]) {
  const upsertCalls: any[] = []
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: (table: string) => {
      if (table === 'push_subscriptions') {
        const chain: any = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.then = (resolve: any) => resolve({ data: subCompanies, error: null })
        return chain
      }
      if (table === 'daily_summary_notifications') {
        const chain: any = {}
        chain.upsert = (payload: any) => { upsertCalls.push(payload); return chain }
        chain.select = () => ({ then: (resolve: any) => resolve({ data: claimResult }) })
        return chain
      }
      throw new Error(`tabela inesperada no mock: ${table}`)
    },
  })
  return { upsertCalls }
}

describe('POST /api/jobs/daily-sales-summary — idempotência + reuso da regra do Dashboard', () => {
  const ORIGINAL_SECRET = process.env.CRON_SECRET
  beforeEach(() => { process.env.CRON_SECRET = 'test-secret' })
  afterEach(() => {
    vi.restoreAllMocks()
    process.env.CRON_SECRET = ORIGINAL_SECRET
  })

  it('sem Authorization correto → 401, não calcula nem envia nada', async () => {
    const sendSpy = vi.spyOn(sendModule, 'sendPushNotification')
    const res = await POST(buildRequest('valor-errado'))
    expect(res.status).toBe(401)
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('idempotência: claim já existe hoje pra essa empresa (upsert não retorna linha) → pula cálculo e envio', async () => {
    mockAdmin([{ company_id: 1 }], [])
    const revenueSpy = vi.spyOn(todayRevenueModule, 'getTodayRevenue')
    const sendSpy = vi.spyOn(sendModule, 'sendPushNotification').mockResolvedValue(undefined)

    const res = await POST(buildRequest('test-secret'))
    expect(res.status).toBe(200)
    expect(revenueSpy).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('claim novo → reusa getTodayRevenue (mesma fonte do Dashboard) e envia push com os números corretos', async () => {
    mockAdmin([{ company_id: 1 }], [{ company_id: 1 }])
    const revenueSpy = vi.spyOn(todayRevenueModule, 'getTodayRevenue')
      .mockResolvedValue({ revenue: 1353.26, orders: 12, avgTicket: 112.77 })
    const sendSpy = vi.spyOn(sendModule, 'sendPushNotification').mockResolvedValue(undefined)

    const res = await POST(buildRequest('test-secret'))
    expect(res.status).toBe(200)
    expect(revenueSpy).toHaveBeenCalledWith(1)
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 1,
      roles:     ['admin'],
      title:     'Santtorini',
      body:      expect.stringContaining('1.353,26'),
    }))
    expect((await res.json()).results).toEqual([{ companyId: 1, revenue: 1353.26, orders: 12 }])
  })

  it('nenhuma empresa com subscription de admin ativa → não processa nada, 200 vazio', async () => {
    mockAdmin([], [])
    const sendSpy = vi.spyOn(sendModule, 'sendPushNotification')

    const res = await POST(buildRequest('test-secret'))
    expect(res.status).toBe(200)
    expect(sendSpy).not.toHaveBeenCalled()
    expect((await res.json()).companies).toBe(0)
  })
})
