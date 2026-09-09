import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendTestPush } from './send'
import { createAdminClient } from '@/lib/supabase/admin'
import webpush from 'web-push'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
}))

const SUB = { id: 1, endpoint: 'https://push.example/abc', p256dh: 'p256', auth: 'auth', company_id: 1, user_id: 'user-uuid' }

function mockAdmin(subs: unknown[]) {
  const updateCalls: any[] = []
  const insertCalls: any[] = []
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: (table: string) => {
      if (table === 'push_subscriptions') {
        const chain: any = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.in = () => chain
        chain.update = (payload: any) => { updateCalls.push(payload); return chain }
        chain.then = (resolve: any) => resolve({ data: subs, error: null })
        return chain
      }
      if (table === 'push_send_logs') {
        return { insert: (payload: any) => { insertCalls.push(payload); return Promise.resolve({ data: null, error: null }) } }
      }
      throw new Error(`tabela inesperada no mock: ${table}`)
    },
  })
  return { updateCalls, insertCalls }
}

describe('sendTestPush — tratamento de status code do provider (send.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.VAPID_SUBJECT = 'mailto:test@example.com'
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'pub'
    process.env.VAPID_PRIVATE_KEY = 'priv'
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.VAPID_SUBJECT
    delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY
  })

  it('sucesso (201) — loga success, atualiza last_seen_at, não desativa a subscription', async () => {
    const { updateCalls, insertCalls } = mockAdmin([SUB])
    ;(webpush.sendNotification as any).mockResolvedValue(undefined)

    const result = await sendTestPush({ userId: 'user-uuid', title: 't', body: 'b', url: '/' })

    expect(result).toEqual({ subscriptionsFound: 1, sent: 1, statuses: [201] })
    expect(insertCalls[0]).toMatchObject({ success: true, status_code: 201 })
    expect(updateCalls.some((u) => u.active === false)).toBe(false)
  })

  it('400/401/403 — NÃO desativa a subscription (erro de config do servidor, não do dispositivo), mas loga o erro', async () => {
    const { updateCalls, insertCalls } = mockAdmin([SUB])
    ;(webpush.sendNotification as any).mockRejectedValue({ statusCode: 403, body: 'Forbidden' })

    const result = await sendTestPush({ userId: 'user-uuid', title: 't', body: 'b', url: '/' })

    expect(result).toEqual({ subscriptionsFound: 1, sent: 0, statuses: [403] })
    expect(insertCalls[0]).toMatchObject({ success: false, status_code: 403, error_message: 'Forbidden' })
    expect(updateCalls.some((u) => u.active === false)).toBe(false)
  })

  it('404/410 — desativa a subscription (browser removeu) e loga o erro', async () => {
    const { updateCalls, insertCalls } = mockAdmin([SUB])
    ;(webpush.sendNotification as any).mockRejectedValue({ statusCode: 410, body: 'Gone' })

    const result = await sendTestPush({ userId: 'user-uuid', title: 't', body: 'b', url: '/' })

    expect(result).toEqual({ subscriptionsFound: 1, sent: 0, statuses: [410] })
    expect(insertCalls[0]).toMatchObject({ success: false, status_code: 410 })
    expect(updateCalls.some((u) => u.active === false)).toBe(true)
  })

  it('sem assinatura ativa — subscriptionsFound 0, não chama web-push', async () => {
    mockAdmin([])
    const result = await sendTestPush({ userId: 'user-uuid', title: 't', body: 'b', url: '/' })
    expect(result).toEqual({ subscriptionsFound: 0, sent: 0, statuses: [] })
    expect(webpush.sendNotification).not.toHaveBeenCalled()
  })
})
