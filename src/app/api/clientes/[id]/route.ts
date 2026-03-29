export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const n = (v: unknown) => (v === '' || v == null ? null : v)

const schema = z.object({
  name: z.string().min(2),
  phone: z.string().min(1),
  birth_date: z.preprocess(n, z.string().nullable().optional()),
  city: z.preprocess(n, z.string().nullable().optional()),
  state: z.preprocess(n, z.string().max(2).nullable().optional()),
  origin: z.preprocess(n, z.enum(['instagram', 'referral', 'paid_traffic', 'website', 'store', 'other']).nullable().optional()),
  notes: z.preprocess(n, z.string().nullable().optional()),
  active: z.boolean().default(true),
})

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const admin = createAdminClient()
  const { data, error } = (await admin.from('customers').select('*').eq('id', Number(params.id)).single()) as unknown as { data: any; error: any }
  if (error || !data) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 })
  return NextResponse.json({ customer: data })
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const { response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = createAdminClient()
  const { error } = (await (admin as any).from('customers').update(parsed.data).eq('id', Number(params.id))) as { error: any }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  // Exclusão de cliente (com histórico) exige gerente
  const { response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  const customerId = Number(params.id)
  if (!Number.isFinite(customerId) || customerId <= 0) {
    return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Bloquear se tiver vendas vinculadas (sem CASCADE)
  const { count: salesCount, error: salesError } = await admin
    .from('sales')
    .select('id', { count: 'exact', head: true })
    .eq('customer_id', customerId)

  if (salesError) return NextResponse.json({ error: salesError.message }, { status: 500 })

  if (salesCount && salesCount > 0) {
    return NextResponse.json(
      { error: 'Cliente possui vendas registradas e não pode ser excluído.' },
      { status: 409 }
    )
  }

  // Bloquear se tiver transações de cashback vinculadas (sem CASCADE)
  const { count: cbCount, error: cbError } = await admin
    .from('cashback_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('customer_id', customerId)

  if (cbError) return NextResponse.json({ error: cbError.message }, { status: 500 })

  if (cbCount && cbCount > 0) {
    return NextResponse.json(
      { error: 'Cliente possui transações de cashback e não pode ser excluído.' },
      { status: 409 }
    )
  }

  // customer_preferences, customer_metrics, customer_addresses têm ON DELETE CASCADE
  const { error: deleteError } = await admin
    .from('customers')
    .delete()
    .eq('id', customerId)

  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
