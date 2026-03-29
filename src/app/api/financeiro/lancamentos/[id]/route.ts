export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireSession } from '@/lib/supabase/session'
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
  const admin = createAdminClient()
  const { data, error } = (await admin.from('finance_entries').select('*').eq('id', Number(params.id)).single()) as unknown as { data: any; error: any }
  if (error || !data) return NextResponse.json({ error: 'Lançamento não encontrado' }, { status: 404 })
  return NextResponse.json({ entry: data })
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const { response: unauth } = await requireSession()
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = createAdminClient()
  const { error } = (await (admin as any).from('finance_entries').update(parsed.data).eq('id', Number(params.id))) as { error: any }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const { response: unauth } = await requireSession()
  if (unauth) return unauth

  const id = Number(params.id)
  if (!id) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const admin = createAdminClient()
  const { error, count } = await admin.from('finance_entries').delete({ count: 'exact' }).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!count) return NextResponse.json({ error: 'Registro não encontrado' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
