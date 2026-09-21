import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { createFakeAdmin, type FakeTables } from '@/services/wholesale/fakeSupabase.testutil'
import { PATCH } from './route'

vi.mock('@/lib/supabase/session', () => ({ requireRole: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/audit/log', () => ({ auditLog: vi.fn() }))

const req = (body: unknown) => new Request('http://x/api/produtos/bulk', { method: 'PATCH', body: typeof body === 'string' ? body : JSON.stringify(body) })
const asUser = (over: Record<string, unknown> = {}) =>
  (requireRole as any).mockResolvedValue({ user: { id: 'u', role: 'gerente', company_id: 1, ...over }, response: null })

let tables: FakeTables
beforeEach(() => {
  vi.clearAllMocks()
  tables = { products: [
    { id: 1, company_id: 1, base_price: 50, wholesale_enabled: false, wholesale_price: null },
    { id: 2, company_id: 2, base_price: 50, wholesale_enabled: false, wholesale_price: null },
  ], product_variations: [] }
  ;(createAdminClient as any).mockReturnValue(createFakeAdmin(tables))
})

describe('PATCH /api/produtos/bulk', () => {
  it('não autenticado → 401 e nada é alterado', async () => {
    ;(requireRole as any).mockResolvedValue({ user: null, response: NextResponse.json({ error: 'Não autorizado.' }, { status: 401 }) })
    const res = await PATCH(req({ product_ids: [1], changes: { wholesale_enabled: true } }))
    expect(res.status).toBe(401)
    expect(tables.products[0].wholesale_enabled).toBe(false)
  })

  it('role insuficiente → 403', async () => {
    ;(requireRole as any).mockResolvedValue({ user: null, response: NextResponse.json({ error: 'Acesso negado.' }, { status: 403 }) })
    expect((await PATCH(req({ product_ids: [1], changes: { wholesale_enabled: true } }))).status).toBe(403)
    expect(requireRole).toHaveBeenCalledWith('gerente')
  })

  it('usuário sem empresa → 403', async () => {
    asUser({ company_id: null })
    expect((await PATCH(req({ product_ids: [1], changes: { wholesale_enabled: true } }))).status).toBe(403)
  })

  it('ativação em massa → 200 com contagem', async () => {
    asUser()
    const res = await PATCH(req({ product_ids: [1], changes: { wholesale_enabled: true } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, updated: 1 })
    expect(tables.products[0].wholesale_enabled).toBe(true)
  })

  it('produto de outro tenant → 404 e não altera', async () => {
    asUser()
    const res = await PATCH(req({ product_ids: [2], changes: { wholesale_enabled: true } }))
    expect(res.status).toBe(404)
    expect(tables.products[1].wholesale_enabled).toBe(false)
  })

  it('company_id no payload é rejeitado (tenant só da sessão)', async () => {
    asUser()
    expect((await PATCH(req({ product_ids: [2], company_id: 2, changes: { wholesale_enabled: true } }))).status).toBe(422)
  })

  it('IDs inválidos e payload excessivo → 422; JSON inválido → 400', async () => {
    asUser()
    expect((await PATCH(req({ product_ids: ['x'], changes: { wholesale_enabled: true } }))).status).toBe(422)
    expect((await PATCH(req({ product_ids: Array.from({ length: 201 }, (_, i) => i + 1), changes: { wholesale_enabled: true } }))).status).toBe(422)
    expect((await PATCH(req('{nope'))).status).toBe(400)
  })
})
