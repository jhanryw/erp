export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  type: z.enum(['income', 'expense']),
  category: z.enum(['sale','cashback_used','other_income','stock_purchase','freight_cost','marketing','rent','salaries','operational','taxes','other_expense']),
  description: z.string().min(2),
  amount: z.coerce.number().positive(),
  reference_date: z.string().min(1),
  notes: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
})

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const admin = createAdminClient()
  const { data, error } = (await (admin as any).from('finance_entries').select('*').eq('id', Number(params.id)).eq('company_id', user.company_id).single()) as unknown as { data: any; error: any }
  if (error || !data) return NextResponse.json({ error: 'Lançamento não encontrado' }, { status: 404 })
  return NextResponse.json({ entry: data })
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = createAdminClient()
  const { error } = (await (admin as any).from('finance_entries').update(parsed.data).eq('id', Number(params.id)).eq('company_id', user.company_id)) as { error: any }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  auditLog({ userId: user.id, userRole: user.role, action: 'update', resource: 'finance_entry', resourceId: params.id, detail: `${parsed.data.type}:${parsed.data.category}` })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const id = Number(params.id)
  if (!id) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const admin = createAdminClient()
  const { error, count } = await (admin as any).from('finance_entries').delete({ count: 'exact' }).eq('id', id).eq('company_id', user.company_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!count) return NextResponse.json({ error: 'Registro não encontrado' }, { status: 404 })

  auditLog({ userId: user.id, userRole: user.role, action: 'delete', resource: 'finance_entry', resourceId: id })
  return NextResponse.json({ ok: true })
}
