import { describe, it, expect, vi, afterEach } from 'vitest'
import { POST } from './route'
import * as sessionModule from '@/lib/supabase/session'
import * as sendModule from '@/lib/push/send'

function mockSession() {
  vi.spyOn(sessionModule, 'requireRole').mockResolvedValue({
    user: { id: 'user-uuid', role: 'admin', company_id: 1 } as any,
    response: null,
  })
}

describe('POST /api/push/test — nunca erro silencioso, sempre um reason explícito', () => {
  afterEach(() => vi.restoreAllMocks())

  it('VAPID não configurada no servidor → reason VAPID_NOT_CONFIGURED, 503, nem tenta enviar', async () => {
    mockSession()
    vi.spyOn(sendModule, 'isVapidConfigured').mockReturnValue(false)
    const sendSpy = vi.spyOn(sendModule, 'sendTestPush')

    const res = await POST()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, reason: 'VAPID_NOT_CONFIGURED' })
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('sem subscription ativa → reason NO_ACTIVE_SUBSCRIPTION, 404', async () => {
    mockSession()
    vi.spyOn(sendModule, 'isVapidConfigured').mockReturnValue(true)
    vi.spyOn(sendModule, 'sendTestPush').mockResolvedValue({ subscriptionsFound: 0, sent: 0, statuses: [] })

    const res = await POST()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, reason: 'NO_ACTIVE_SUBSCRIPTION' })
  })

  it('provider recusa o envio (ex: VAPID errada) → reason WEB_PUSH_FAILED com statusCode, 502', async () => {
    mockSession()
    vi.spyOn(sendModule, 'isVapidConfigured').mockReturnValue(true)
    vi.spyOn(sendModule, 'sendTestPush').mockResolvedValue({ subscriptionsFound: 1, sent: 0, statuses: [403] })

    const res = await POST()
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ ok: false, reason: 'WEB_PUSH_FAILED', statusCode: 403 })
  })

  it('sucesso — ok:true com contadores reais (subscriptionsFound/sent/failed/statuses)', async () => {
    mockSession()
    vi.spyOn(sendModule, 'isVapidConfigured').mockReturnValue(true)
    vi.spyOn(sendModule, 'sendTestPush').mockResolvedValue({ subscriptionsFound: 1, sent: 1, statuses: [201] })

    const res = await POST()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, subscriptionsFound: 1, sent: 1, failed: 0, statuses: [201] })
  })

  it('sem sessão → 401/403, nunca chega a checar VAPID', async () => {
    vi.spyOn(sessionModule, 'requireRole').mockResolvedValue({
      user: null as any,
      response: new Response(JSON.stringify({ error: 'Não autorizado.' }), { status: 401 }) as any,
    })
    const vapidSpy = vi.spyOn(sendModule, 'isVapidConfigured')

    const res = await POST()
    expect(res.status).toBe(401)
    expect(vapidSpy).not.toHaveBeenCalled()
  })
})
