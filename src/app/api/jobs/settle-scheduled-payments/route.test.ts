import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { POST } from './route'
import * as adminModule from '@/lib/supabase/admin'

const req = (auth?: string) =>
  new Request('http://x', { method: 'POST', headers: auth ? { Authorization: auth } : {} })

describe('POST /api/jobs/settle-scheduled-payments', () => {
  beforeEach(() => { process.env.CRON_SECRET = 'segredo' })
  afterEach(() => { vi.restoreAllMocks(); delete process.env.CRON_SECRET })

  it('sem Bearer correto -> 401 e não chama o banco', async () => {
    const spy = vi.spyOn(adminModule, 'createAdminClient')
    expect((await POST(req())).status).toBe(401)
    expect((await POST(req('Bearer errado'))).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it('sem CRON_SECRET configurado -> 401 (nunca aceita "Bearer undefined")', async () => {
    delete process.env.CRON_SECRET
    expect((await POST(req('Bearer undefined'))).status).toBe(401)
  })

  it('autorizado: delega à função SQL e devolve o resumo', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { today: '2026-11-23', settled: 1, by_company: { '1': 1 } }, error: null })
    vi.spyOn(adminModule, 'createAdminClient').mockReturnValue({ rpc } as any)
    const res = await POST(req('Bearer segredo'))
    expect(rpc).toHaveBeenCalledWith('fn_settle_scheduled_payments')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ settled: 1 })
  })

  it('erro do banco -> 500', async () => {
    vi.spyOn(adminModule, 'createAdminClient').mockReturnValue({ rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'x' } }) } as any)
    expect((await POST(req('Bearer segredo'))).status).toBe(500)
  })
})
