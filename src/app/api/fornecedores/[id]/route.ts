export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { canDeleteSupplier, getSupplierSnapshot, updateSupplier } from '@/services/fornecedores.service'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const n = (v: unknown) => (v === '' || v == null ? null : v)

const putSchema = z.object({
  name:     z.string().min(2),
  document: z.preprocess(n, z.string().nullable().optional()),
  phone:    z.preprocess(n, z.string().nullable().optional()),
  city:     z.preprocess(n, z.string().nullable().optional()),
  state:    z.preprocess(n, z.string().nullable().optional()),
  notes:    z.preprocess(n, z.string().nullable().optional()),
  active:   z.boolean().default(true),
})

// ─── GET /api/fornecedores/[id] ───────────────────────────────────────────────

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('suppliers')
    .select('*')
    .eq('id', Number(params.id))
    .eq('company_id', user.company_id)
    .single() as unknown as { data: any; error: any }
  if (error || !data) return NextResponse.json({ error: 'Fornecedor não encontrado' }, { status: 404 })
  return NextResponse.json({ supplier: data })
}

// ─── PUT /api/fornecedores/[id] ───────────────────────────────────────────────

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  const supplierId = Number(params.id)
  if (!Number.isFinite(supplierId) || supplierId <= 0) {
    return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  }

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = putSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const before = await getSupplierSnapshot(supplierId, user.company_id)
  if (!before) return NextResponse.json({ error: 'Fornecedor não encontrado' }, { status: 404 })

  const result = await updateSupplier(supplierId, parsed.data, user.company_id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  const after = await getSupplierSnapshot(supplierId)
  auditLog({
    userId: user.id, userRole: user.role,
    action: 'update', resource: 'supplier', resourceId: supplierId,
    before: before ?? undefined, after: after ?? undefined,
  })
  return NextResponse.json({ ok: true })
}

// ─── DELETE /api/fornecedores/[id] ───────────────────────────────────────────

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  // Exclusão de fornecedor — exige admin
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth

  const supplierId = Number(params.id)
  if (!Number.isFinite(supplierId) || supplierId <= 0) {
    return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  }

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const before = await getSupplierSnapshot(supplierId, user.company_id)
  if (!before) return NextResponse.json({ error: 'Fornecedor não encontrado' }, { status: 404 })

  // Verificar regras de negócio via service (produtos + stock_lots FK guards)
  const check = await canDeleteSupplier(supplierId)
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })

  const admin = createAdminClient()
  const { error } = await admin.from('suppliers').delete().eq('id', supplierId).eq('company_id', user.company_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'delete', resource: 'supplier', resourceId: supplierId,
    before: before ?? undefined,
  })
  return NextResponse.json({ ok: true })
}
