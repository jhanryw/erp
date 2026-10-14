import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { createFakeAdmin, type FakeTables } from './fakeSupabase.testutil'
import { configureWholesaleCache } from '@/lib/wholesale/ttlCache'
import {
  announcementInputSchema, announcementPatchSchema, createAnnouncement, deleteAnnouncement,
  getActiveAnnouncements, listAnnouncements, reorderAnnouncements, updateAnnouncement,
} from './announcements'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

const A = 1
const B = 2
let tables: FakeTables
const input = (over: Record<string, unknown> = {}) => announcementInputSchema.parse({ message: 'Atacado a partir do pedido mínimo', ...over })

beforeEach(() => {
  vi.resetAllMocks()
  configureWholesaleCache({ ttlMs: null })
  tables = { wholesale_site_announcements: [] }
  ;(createAdminClient as any).mockImplementation(() => createFakeAdmin(tables))
})

describe('validação', () => {
  it('padrões de cor com contraste e ativa por padrão', () => {
    expect(input()).toMatchObject({ backgroundColor: '#A71818', textColor: '#FFFFFF', isActive: true, linkUrl: null })
  })

  it.each([
    ['mensagem vazia', { message: '   ' }],
    ['mensagem com mais de 160', { message: 'x'.repeat(161) }],
    ['link javascript:', { linkUrl: 'javascript:alert(1)' }],
    ['link data:', { linkUrl: 'data:text/html,<script>' }],
    ['cor inválida', { backgroundColor: 'red' }],
    ['contraste insuficiente', { backgroundColor: '#FFFFFF', textColor: '#EEEEEE' }],
    ['campo desconhecido (company_id)', { company_id: 9 }],
  ])('recusa %s', (_n, over) => {
    expect(announcementInputSchema.safeParse({ message: 'Oi', ...over }).success).toBe(false)
  })

  it('PATCH: chave ausente fica undefined; link vazio limpa para null', () => {
    expect(announcementPatchSchema.parse({ isActive: false })).toEqual({ isActive: false })
    expect(announcementPatchSchema.parse({ linkUrl: '  ' }).linkUrl).toBeNull()
    expect(announcementPatchSchema.safeParse({ linkUrl: 'vbscript:x' }).success).toBe(false)
  })
})

describe('CRUD e ordem', () => {
  it('cria em sequência, edita, ativa/desativa, reordena e exclui', async () => {
    const a = await createAnnouncement(A, input({ message: 'Primeira' }))
    const b = await createAnnouncement(A, input({ message: 'Segunda', linkUrl: '/categorias' }))
    if (!a.ok || !b.ok) throw new Error('setup')
    expect([a.data.sortOrder, b.data.sortOrder]).toEqual([0, 1])

    const edited = await updateAnnouncement(A, a.data.id, { message: 'Primeira editada', isActive: false })
    expect(edited.ok && edited.data).toMatchObject({ message: 'Primeira editada', isActive: false })

    await reorderAnnouncements(A, [b.data.id, a.data.id])
    expect((await listAnnouncements(A)).announcements.map((x) => x.message)).toEqual(['Segunda', 'Primeira editada'])

    expect(await deleteAnnouncement(A, a.data.id)).toEqual({ ok: true })
    expect((await listAnnouncements(A)).announcements).toHaveLength(1)
  })

  it('PATCH recusa cores que ficam abaixo do contraste (mesmo mudando só uma delas)', async () => {
    const a = await createAnnouncement(A, input())
    if (!a.ok) throw new Error('setup')
    expect(await updateAnnouncement(A, a.data.id, { textColor: '#B02020' })).toMatchObject({ ok: false, status: 422 })
    expect(tables.wholesale_site_announcements[0].text_color).toBe('#FFFFFF')
  })
})

describe('isolamento multi-tenant', () => {
  it('empresa B não vê, edita, exclui nem reordena anúncios da A', async () => {
    const a = await createAnnouncement(A, input({ message: 'Da A' }))
    if (!a.ok) throw new Error('setup')

    expect((await listAnnouncements(B)).announcements).toEqual([])
    expect(await updateAnnouncement(B, a.data.id, { message: 'Invadido' })).toMatchObject({ ok: false, status: 404 })
    expect(await deleteAnnouncement(B, a.data.id)).toMatchObject({ ok: false, status: 404 })
    await reorderAnnouncements(B, [a.data.id])
    expect(tables.wholesale_site_announcements[0]).toMatchObject({ message: 'Da A', sort_order: 0, company_id: A })
    expect(await getActiveAnnouncements(B)).toEqual([])
  })
})

describe('leitura pública', () => {
  it('só ativas, na ordem; link inseguro e cores ilegíveis vindos do banco são neutralizados', async () => {
    tables.wholesale_site_announcements.push(
      { id: 1, company_id: A, message: 'Inativa', link_url: null, background_color: '#A71818', text_color: '#FFFFFF', is_active: false, sort_order: 0 },
      { id: 2, company_id: A, message: 'Segunda', link_url: null, background_color: '#A71818', text_color: '#FFFFFF', is_active: true, sort_order: 2 },
      { id: 3, company_id: A, message: 'Primeira', link_url: 'javascript:alert(1)', background_color: '#FFFFFF', text_color: '#FEFEFE', is_active: true, sort_order: 1 },
    )
    const active = await getActiveAnnouncements(A)
    expect(active.map((x) => x.message)).toEqual(['Primeira', 'Segunda'])
    expect(active[0]).toMatchObject({ linkUrl: null, backgroundColor: '#A71818', textColor: '#FFFFFF' })
  })

  it('migration ausente ou erro de banco → lista vazia (sem barra, sem erro na página)', async () => {
    const real = createFakeAdmin(tables)
    ;(createAdminClient as any).mockImplementation(() => ({
      ...real,
      from: () => { const q: any = { select: () => q, eq: () => q, order: () => q, then: (r: any) => r({ data: null, error: { code: '42P01', message: 'relation does not exist' } }) }; return q },
    }))
    expect(await getActiveAnnouncements(A)).toEqual([])
    expect(await listAnnouncements(A)).toEqual({ announcements: [], migrationPending: true })
  })

  it('cache por empresa é invalidado ao criar/editar/excluir', async () => {
    configureWholesaleCache({ ttlMs: 30_000 })
    const a = await createAnnouncement(A, input({ message: 'Um' }))
    expect((await getActiveAnnouncements(A)).map((x) => x.message)).toEqual(['Um'])
    if (!a.ok) throw new Error('setup')
    await updateAnnouncement(A, a.data.id, { message: 'Um editado' })
    expect((await getActiveAnnouncements(A)).map((x) => x.message)).toEqual(['Um editado'])
    await deleteAnnouncement(A, a.data.id)
    expect(await getActiveAnnouncements(A)).toEqual([])
    configureWholesaleCache({ ttlMs: null })
  })
})
