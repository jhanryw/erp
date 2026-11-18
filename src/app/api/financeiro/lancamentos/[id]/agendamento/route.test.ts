import { describe, it, expect, vi, afterEach } from 'vitest'
import { POST } from './route'
import * as sessionModule from '@/lib/supabase/session'
import * as adminModule from '@/lib/supabase/admin'
import { brazilDate } from '@/lib/utils/date'

vi.mock('@/lib/audit/log', () => ({ auditLog: vi.fn() }))

const today = brazilDate()
const future = '2999-01-01'

function mockGerente() {
  vi.spyOn(sessionModule, 'requireRole').mockResolvedValue({
    user: { id: 'u1', role: 'gerente', company_id: 1 } as any, response: null,
  })
}

// Cliente fake: select devolve `row`; update registra o patch e os filtros.
function mockAdmin(row: any, updateCount = 1) {
  const calls: { patch?: any; filters: [string, unknown][] } = { filters: [] }
  vi.spyOn(adminModule, 'createAdminClient').mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row }) }) }),
      }),
      update: (patch: any) => {
        calls.patch = patch
        const chain: any = {
          eq: (k: string, v: unknown) => { calls.filters.push([k, v]); return chain },
          then: (res: any) => res({ error: null, count: updateCount }),
        }
        return chain
      },
    }),
  } as any)
  return calls
}

const req = (body: unknown) =>
  new Request('http://x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const scheduled = { id: 1, payment_status: 'scheduled', paid_at: future, payment_method: 'pix' }

describe('POST /api/financeiro/lancamentos/[id]/agendamento', () => {
  afterEach(() => vi.restoreAllMocks())

  it('confirma: scheduled -> paid com data de hoje, condicionado ao status', async () => {
    mockGerente()
    const c = mockAdmin(scheduled)
    const res = await POST(req({ action: 'confirm' }), { params: { id: '1' } })
    expect(res.status).toBe(200)
    expect(c.patch).toEqual({ payment_status: 'paid', paid_at: today })
    expect(c.filters).toContainEqual(['payment_status', 'scheduled'])
    expect(c.filters).toContainEqual(['company_id', 1])
  })

  it('confirma com data futura é rejeitado', async () => {
    mockGerente(); mockAdmin(scheduled)
    const res = await POST(req({ action: 'confirm', paid_at: future }), { params: { id: '1' } })
    expect(res.status).toBe(422)
  })

  it('cancela: volta a pending e limpa forma/data', async () => {
    mockGerente()
    const c = mockAdmin(scheduled)
    const res = await POST(req({ action: 'cancel' }), { params: { id: '1' } })
    expect(res.status).toBe(200)
    expect(c.patch).toEqual({ payment_status: 'pending', paid_at: null, payment_method: null })
  })

  it('reagenda para nova data; data passada é rejeitada', async () => {
    mockGerente()
    const c = mockAdmin(scheduled)
    expect((await POST(req({ action: 'reschedule', paid_at: '2999-02-02' }), { params: { id: '1' } })).status).toBe(200)
    expect(c.patch).toEqual({ paid_at: '2999-02-02' })
    expect((await POST(req({ action: 'reschedule', paid_at: '2000-01-01' }), { params: { id: '1' } })).status).toBe(422)
  })

  it('registro que não está agendado -> 409 (ex.: já confirmado em outra aba)', async () => {
    mockGerente(); mockAdmin({ ...scheduled, payment_status: 'paid' })
    expect((await POST(req({ action: 'confirm' }), { params: { id: '1' } })).status).toBe(409)
  })

  it('corrida: UPDATE afeta 0 linhas -> 409', async () => {
    mockGerente(); mockAdmin(scheduled, 0)
    expect((await POST(req({ action: 'confirm' }), { params: { id: '1' } })).status).toBe(409)
  })

  it('registro de outra empresa/inexistente -> 404', async () => {
    mockGerente(); mockAdmin(null)
    expect((await POST(req({ action: 'cancel' }), { params: { id: '1' } })).status).toBe(404)
  })

  it('ação inválida -> 422', async () => {
    mockGerente(); mockAdmin(scheduled)
    expect((await POST(req({ action: 'x' }), { params: { id: '1' } })).status).toBe(422)
  })
})
