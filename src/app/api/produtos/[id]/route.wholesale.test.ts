import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { getProductSnapshot } from '@/services/produtos.service'
import { createFakeAdmin, type FakeTables } from '@/services/wholesale/fakeSupabase.testutil'
import { putSchema } from './putSchema'
import { PUT } from './route'

vi.mock('@/lib/supabase/session', () => ({ requireRole: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/audit/log', () => ({ auditLog: vi.fn() }))
vi.mock('@/services/produtos.service', () => ({
  getProductSnapshot: vi.fn(),
  checkPriceChange: vi.fn().mockResolvedValue({ warning: undefined }),
  canDeleteProduct: vi.fn(),
  deleteProductCascade: vi.fn(),
}))

let tables: FakeTables
const put = (id: string, body: unknown) => PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }), { params: { id } })

beforeEach(() => {
  vi.clearAllMocks()
  tables = { products: [
    { id: 1, company_id: 1, name: 'A', sku: 'AA', category_id: 1, supplier_id: null, brand_id: null, origin: 'own_brand', base_cost: 10, base_price: 50, active: true, ncm: null, cest: null, origem: null, unidade_med: 'UN', wholesale_enabled: false },
    { id: 2, company_id: 2, name: 'B', sku: 'BB', category_id: 1, supplier_id: null, brand_id: null, origin: 'own_brand', base_cost: 10, base_price: 50, active: true, ncm: null, cest: null, origem: null, unidade_med: 'UN', wholesale_enabled: false },
  ] }
  ;(createAdminClient as any).mockReturnValue(createFakeAdmin(tables))
  ;(requireRole as any).mockResolvedValue({ user: { id: 'u', role: 'gerente', company_id: 1 }, response: null })
  ;(getProductSnapshot as any).mockImplementation(async (id: number, companyId: number) => {
    const p = tables.products.find((x) => x.id === id && x.company_id === companyId)
    return p ? { ...p } : null
  })
})

describe('PUT /api/produtos/[id] — wholesale_enabled', () => {
  it('putSchema aceita wholesale_enabled boolean e rejeita outros tipos', () => {
    expect(putSchema.safeParse({ wholesale_enabled: true }).success).toBe(true)
    expect(putSchema.safeParse({ wholesale_enabled: 'sim' }).success).toBe(false)
    expect(putSchema.parse({ name: 'xx' }).wholesale_enabled).toBeUndefined() // ausente = não toca
  })

  it('não autenticado → 401, nada alterado', async () => {
    ;(requireRole as any).mockResolvedValue({ user: null, response: NextResponse.json({ error: 'Não autorizado.' }, { status: 401 }) })
    expect((await put('1', { wholesale_enabled: true })).status).toBe(401)
    expect(tables.products[0].wholesale_enabled).toBe(false)
  })

  it('ativação individual', async () => {
    const res = await put('1', { wholesale_enabled: true })
    expect(res.status).toBe(200)
    expect(tables.products[0].wholesale_enabled).toBe(true)
  })

  it('desativação individual', async () => {
    tables.products[0].wholesale_enabled = true
    expect((await put('1', { wholesale_enabled: false })).status).toBe(200)
    expect(tables.products[0].wholesale_enabled).toBe(false)
  })

  it('PUT sem o campo nunca altera wholesale_enabled', async () => {
    tables.products[0].wholesale_enabled = true
    expect((await put('1', { name: 'Novo nome' })).status).toBe(200)
    expect(tables.products[0].wholesale_enabled).toBe(true)
  })

  it('produto de outro tenant → 404 e não altera', async () => {
    const res = await put('2', { wholesale_enabled: true })
    expect(res.status).toBe(404)
    expect(tables.products[1].wholesale_enabled).toBe(false)
  })
})
