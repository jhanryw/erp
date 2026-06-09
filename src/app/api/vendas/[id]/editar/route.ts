import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { auditLog } from '@/lib/audit/log'

const schema = z.object({
  sale_origin:    z.preprocess(
    (v) => (v === '' || v == null ? null : v),
    z.enum(['instagram', 'paid_traffic', 'referral', 'website', 'store', 'other']).nullable().optional()
  ),
  notes:          z.preprocess(
    (v) => (v === '' || v == null ? null : v),
    z.string().max(1000).nullable().optional()
  ),
  sale_date:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) {
    return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  }

  const saleId = Number(params.id)
  if (!saleId) return NextResponse.json({ error: 'ID inválido.' }, { status: 400 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const admin = createAdminClient()

  // Confirma que a venda pertence à empresa
  const { data: existing } = await (admin as any)
    .from('sales')
    .select('id, sale_origin, notes, sale_date, status')
    .eq('id', saleId)
    .eq('company_id', user.company_id)
    .single() as { data: { id: number; sale_origin: string | null; notes: string | null; sale_date: string; status: string } | null }

  if (!existing) {
    return NextResponse.json({ error: 'Venda não encontrada.' }, { status: 404 })
  }

  // Monta apenas os campos enviados
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if ('sale_origin' in parsed.data) updates.sale_origin = parsed.data.sale_origin ?? null
  if ('notes'       in parsed.data) updates.notes       = parsed.data.notes       ?? null
  if ('sale_date'   in parsed.data) updates.sale_date   = parsed.data.sale_date

  const { error: updateError } = await (admin as any)
    .from('sales')
    .update(updates)
    .eq('id', saleId)

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'update', resource: 'sale', resourceId: saleId,
    before: { sale_origin: existing.sale_origin, notes: existing.notes, sale_date: existing.sale_date },
    after:  updates,
  })

  return NextResponse.json({ ok: true })
}
