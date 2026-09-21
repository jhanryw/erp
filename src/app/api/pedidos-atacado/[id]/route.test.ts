import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { createFakeAdmin, type FakeTables } from '@/services/wholesale/fakeSupabase.testutil'
import { PATCH } from './route'

vi.mock('@/lib/supabase/session', () => ({ requireRole: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/audit/log', () => ({ auditLog: vi.fn() }))

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
let tables: FakeTables
const call = (id: string, body: unknown) => PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }), { params: { id } })

beforeEach(() => {
  vi.resetAllMocks()
  tables = { wholesale_orders: [{ id: A, company_id: 1, status: 'pending' }, { id: B, company_id: 2, status: 'pending' }] }
  ;(createAdminClient as any).mockReturnValue(createFakeAdmin(tables))
  ;(requireRole as any).mockResolvedValue({ user: { id: 'u', role: 'usuario', company_id: 1 }, response: null })
})

describe('PATCH /api/pedidos-atacado/[id]', () => {
  it('não autenticado → 401', async () => {
    ;(requireRole as any).mockResolvedValue({ user: null, response: NextResponse.json({ error: 'x' }, { status: 401 }) })
    expect((await call(A, { status: 'finalized' })).status).toBe(401)
    expect(tables.wholesale_orders[0].status).toBe('pending')
  })
  it('altera o status do pedido da própria empresa', async () => {
    expect((await call(A, { status: 'finalized' })).status).toBe(200)
    expect(tables.wholesale_orders[0].status).toBe('finalized')
  })
  it('pedido de OUTRA empresa → 404 e não altera', async () => {
    expect((await call(B, { status: 'cancelled' })).status).toBe(404)
    expect(tables.wholesale_orders[1].status).toBe('pending')
  })
  it('valida id e status (campos extras/estados inválidos rejeitados)', async () => {
    expect((await call('nope', { status: 'finalized' })).status).toBe(400)
    expect((await call(A, { status: 'converted' })).status).toBe(422)
    expect((await call(A, { status: 'finalized', company_id: 2 })).status).toBe(422)
  })
  it('usuário sem empresa → 403', async () => {
    ;(requireRole as any).mockResolvedValue({ user: { id: 'u', role: 'usuario', company_id: null }, response: null })
    expect((await call(A, { status: 'finalized' })).status).toBe(403)
  })
})
