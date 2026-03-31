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

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const admin = createAdminClient()
  const { error } = await admin.from('finance_entries').insert({ ...parsed.data, created_by: user.id, company_id: user.company_id } as any)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  auditLog({ userId: user.id, userRole: user.role, action: 'create', resource: 'finance_entry', detail: `${parsed.data.type}:${parsed.data.category}:${parsed.data.amount}` })
  return NextResponse.json({ ok: true }, { status: 201 })
}
