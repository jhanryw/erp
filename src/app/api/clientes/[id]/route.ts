export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { canDeleteCustomer, getCustomerSnapshot, updateCustomer } from '@/services/clientes.service'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const n = (v: unknown) => (v === '' || v == null ? null : v)

const putSchema = z.object({
  name:       z.string().min(2),
  phone:      z.string().min(1),
  birth_date: z.preprocess(n, z.string().nullable().optional()),
  city:       z.preprocess(n, z.string().nullable().optional()),
  state:      z.preprocess(n, z.string().max(2).nullable().optional()),
  origin:     z.preprocess(n, z.enum(['instagram', 'referral', 'paid_traffic', 'website', 'store', 'other']).nullable().optional()),
  notes:      z.preprocess(n, z.string().nullable().optional()),
  active:     z.boolean().default(true),
})

// ─── GET /api/clientes/[id] ───────────────────────────────────────────────────

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('customers')
    .select('*')
    .eq('id', Number(params.id))
    .eq('company_id', user.company_id)
    .single() as unknown as { data: any; error: any }
  if (error || !data) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 })
  return NextResponse.json({ customer: data })
}

// ─── PUT /api/clientes/[id] ───────────────────────────────────────────────────

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  const customerId = Number(params.id)
  if (!Number.isFinite(customerId) || customerId <= 0) {
    return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  }

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = putSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const before = await getCustomerSnapshot(customerId, user.company_id)
  const result = await updateCustomer(customerId, parsed.data, user.company_id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  const after = await getCustomerSnapshot(customerId)
  auditLog({
    userId: user.id, userRole: user.role,
    action: 'update', resource: 'customer', resourceId: customerId,
    before: before ?? undefined, after: after ?? undefined,
  })
  return NextResponse.json({ ok: true })
}

// ─── DELETE /api/clientes/[id] ────────────────────────────────────────────────

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  // Exclusão de cliente com histórico — exige gerente
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  const customerId = Number(params.id)
  if (!Number.isFinite(customerId) || customerId <= 0) {
    return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  }

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const before = await getCustomerSnapshot(customerId, user.company_id)
  if (!before) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 })

  // Verificar regras de negócio via service (vendas + cashback FK guards)
  const check = await canDeleteCustomer(customerId)
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })

  // customer_preferences, customer_metrics, customer_addresses têm ON DELETE CASCADE
  const admin = createAdminClient()
  const { error } = await admin.from('customers').delete().eq('id', customerId).eq('company_id', user.company_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'delete', resource: 'customer', resourceId: customerId,
    before: before ?? undefined,
  })
  return NextResponse.json({ ok: true })
}
