import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requireRole } from '@/lib/supabase/session'
import { createColorGroup, listColorGroups, updateColorGroup, deleteColorGroup } from '@/services/wholesale/colorGroups'
import { GET, POST } from './route'
import { PATCH, DELETE } from './[id]/route'

vi.mock('@/lib/supabase/session', () => ({ requireRole: vi.fn() }))
vi.mock('@/services/wholesale/colorGroups', () => ({
  createColorGroup: vi.fn(), listColorGroups: vi.fn(), updateColorGroup: vi.fn(), deleteColorGroup: vi.fn(),
}))

const req = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
const ctx = (id: string) => ({ params: { id } })

beforeEach(() => {
  vi.resetAllMocks()
  ;(requireRole as any).mockResolvedValue({ user: { company_id: 7, role: 'admin' }, response: null })
  ;(listColorGroups as any).mockResolvedValue({ groups: [], ungrouped: [], suggestions: [] })
  ;(createColorGroup as any).mockResolvedValue({ ok: true, data: { id: 1 } })
  ;(updateColorGroup as any).mockResolvedValue({ ok: true })
  ;(deleteColorGroup as any).mockResolvedValue({ ok: true })
})

describe('/api/configuracoes/atacado/cores — autorização e tenant', () => {
  it('exige papel admin: sem permissão nenhuma operação acontece', async () => {
    ;(requireRole as any).mockResolvedValue({ user: null, response: new Response('{}', { status: 403 }) })
    expect((await GET()).status).toBe(403)
    expect((await POST(req({ name: 'x', productIds: [1, 2] }))).status).toBe(403)
    expect((await PATCH(req({ name: 'x' }), ctx('1'))).status).toBe(403)
    expect((await DELETE(req({}), ctx('1'))).status).toBe(403)
    for (const fn of [listColorGroups, createColorGroup, updateColorGroup, deleteColorGroup]) expect(fn).not.toHaveBeenCalled()
    expect(requireRole).toHaveBeenCalledWith('admin')
  })

  it('usuário sem empresa é recusado', async () => {
    ;(requireRole as any).mockResolvedValue({ user: { company_id: null, role: 'admin' }, response: null })
    expect((await GET()).status).toBe(403)
    expect((await POST(req({ name: 'x', productIds: [1, 2] }))).status).toBe(403)
  })

  it('SEMPRE usa a empresa da sessão — company_id no corpo é ignorado', async () => {
    await POST(req({ name: 'Modelo', productIds: [1, 2], company_id: 99, companyId: 99 }))
    expect(createColorGroup).toHaveBeenCalledWith(7, 'Modelo', [1, 2])
    await PATCH(req({ name: 'Novo', company_id: 99 }), ctx('5'))
    expect(updateColorGroup).toHaveBeenCalledWith(7, 5, { name: 'Novo' })
    await DELETE(req({}), ctx('5'))
    expect(deleteColorGroup).toHaveBeenCalledWith(7, 5)
  })

  it('valida entrada: menos de 2 produtos, ids inválidos e nome vazio', async () => {
    expect((await POST(req({ name: 'x', productIds: [1] }))).status).toBe(422)
    expect((await POST(req({ name: ' ', productIds: [1, 2] }))).status).toBe(422)
    expect((await POST(req({ name: 'x', productIds: [1, -2] }))).status).toBe(422)
    expect((await PATCH(req({}), ctx('abc'))).status).toBe(400)
    expect(createColorGroup).not.toHaveBeenCalled()
  })

  it('erro do serviço (outra empresa/404/409) é repassado com o status', async () => {
    ;(updateColorGroup as any).mockResolvedValue({ ok: false, error: 'Grupo não encontrado.', status: 404 })
    expect((await PATCH(req({ name: 'x' }), ctx('9'))).status).toBe(404)
    ;(createColorGroup as any).mockResolvedValue({ ok: false, error: 'já em outro grupo', status: 409 })
    expect((await POST(req({ name: 'x', productIds: [1, 2] }))).status).toBe(409)
  })
})
