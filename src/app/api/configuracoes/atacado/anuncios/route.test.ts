import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requireRole } from '@/lib/supabase/session'
import { createAnnouncement, deleteAnnouncement, listAnnouncements, reorderAnnouncements, updateAnnouncement } from '@/services/wholesale/announcements'
import { GET, POST } from './route'
import { PATCH, DELETE } from './[id]/route'
import { POST as REORDER } from './reorder/route'

vi.mock('@/lib/supabase/session', () => ({ requireRole: vi.fn() }))
vi.mock('@/services/wholesale/announcements', async (orig) => ({
  ...(await orig<any>()),
  createAnnouncement: vi.fn(), listAnnouncements: vi.fn(), updateAnnouncement: vi.fn(), deleteAnnouncement: vi.fn(), reorderAnnouncements: vi.fn(),
}))

const req = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
const ctx = (id: string) => ({ params: { id } })

beforeEach(() => {
  vi.resetAllMocks()
  ;(requireRole as any).mockResolvedValue({ user: { company_id: 7, role: 'admin' }, response: null })
  ;(listAnnouncements as any).mockResolvedValue({ announcements: [], migrationPending: false })
  ;(createAnnouncement as any).mockResolvedValue({ ok: true, data: { id: 1 } })
  ;(updateAnnouncement as any).mockResolvedValue({ ok: true, data: { id: 1 } })
  ;(deleteAnnouncement as any).mockResolvedValue({ ok: true })
  ;(reorderAnnouncements as any).mockResolvedValue({ ok: true })
})

describe('/api/configuracoes/atacado/anuncios', () => {
  it('exige admin em todas as operações; sem permissão nada é executado', async () => {
    ;(requireRole as any).mockResolvedValue({ user: null, response: new Response('{}', { status: 403 }) })
    const results = await Promise.all([GET(), POST(req({ message: 'x' })), PATCH(req({}), ctx('1')), DELETE(req({}), ctx('1')), REORDER(req({ ids: [1] }))])
    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403, 403])
    for (const fn of [listAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement, reorderAnnouncements]) expect(fn).not.toHaveBeenCalled()
  })

  it('usa SEMPRE a empresa da sessão (company_id do corpo é rejeitado pelo schema strict)', async () => {
    expect((await POST(req({ message: 'Oi', company_id: 99 }))).status).toBe(422)
    expect(createAnnouncement).not.toHaveBeenCalled()
    await POST(req({ message: 'Oi' }))
    expect(createAnnouncement).toHaveBeenCalledWith(7, expect.objectContaining({ message: 'Oi' }))
    await PATCH(req({ isActive: false }), ctx('5'))
    expect(updateAnnouncement).toHaveBeenCalledWith(7, 5, { isActive: false })
    await DELETE(req({}), ctx('5'))
    expect(deleteAnnouncement).toHaveBeenCalledWith(7, 5)
    await REORDER(req({ ids: [3, 1, 2] }))
    expect(reorderAnnouncements).toHaveBeenCalledWith(7, [3, 1, 2])
  })

  it('recusa link inseguro, mensagem longa e contraste insuficiente', async () => {
    expect((await POST(req({ message: 'Oi', linkUrl: 'javascript:alert(1)' }))).status).toBe(422)
    expect((await POST(req({ message: 'x'.repeat(161) }))).status).toBe(422)
    expect((await POST(req({ message: 'Oi', backgroundColor: '#FFFFFF', textColor: '#FAFAFA' }))).status).toBe(422)
    expect((await PATCH(req({ linkUrl: 'data:text/html,x' }), ctx('1'))).status).toBe(422)
    expect(createAnnouncement).not.toHaveBeenCalled()
    expect(updateAnnouncement).not.toHaveBeenCalled()
  })

  it('erro do serviço (404 de outra empresa) é repassado; id inválido → 400', async () => {
    ;(updateAnnouncement as any).mockResolvedValue({ ok: false, error: 'Anúncio não encontrado.', status: 404 })
    expect((await PATCH(req({ isActive: true }), ctx('9'))).status).toBe(404)
    expect((await PATCH(req({}), ctx('abc'))).status).toBe(400)
  })
})
