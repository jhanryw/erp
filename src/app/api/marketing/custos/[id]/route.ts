export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  category: z.enum(['paid_traffic','content','design','photos','influencers','tools','crm_automation','website_landing_page','events','gifts','packaging','agency_freelancer','other']),
  description: z.string().min(2),
  amount: z.coerce.number().positive(),
  cost_date: z.string().min(1),
  campaign_id: z.coerce.number().int().positive().nullable().optional(),
  is_recurring: z.boolean().default(false),
  notes: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
})

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  // Fase 2 (revisão) — Marketing liberado para usuario (módulo completo).
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const admin = createAdminClient()
  const { data, error } = (await (admin as any).from('marketing_costs').select('*').eq('id', Number(params.id)).eq('company_id', user.company_id).single()) as unknown as { data: any; error: any }
  if (error || !data) return NextResponse.json({ error: 'Custo não encontrado' }, { status: 404 })
  return NextResponse.json({ cost: data })
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  // Fase 2 (revisão) — Marketing liberado para usuario (módulo completo).
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const costId = Number(params.id)
  const admin = createAdminClient()

  const { error } = (await (admin as any)
    .from('marketing_costs')
    .update({ ...parsed.data, campaign_id: parsed.data.campaign_id ?? null })
    .eq('id', costId)
    .eq('company_id', user.company_id)) as { error: { message: string } | null }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Atualiza finance_entry vinculada; cria se não existir (garante consistência)
  const { data: existing } = await (admin as any)
    .from('finance_entries')
    .select('id')
    .eq('marketing_cost_id', costId)
    .maybeSingle() as { data: { id: number } | null }

  if (existing) {
    const { error: feError } = await (admin as any)
      .from('finance_entries')
      .update({
        description:    parsed.data.description,
        amount:         parsed.data.amount,
        reference_date: parsed.data.cost_date,
      })
      .eq('id', existing.id)

    if (feError) return NextResponse.json({ error: feError.message }, { status: 500 })
  } else {
    const { error: feError } = await (admin as any)
      .from('finance_entries')
      .insert({
        type:              'expense',
        category:          'marketing',
        description:       parsed.data.description,
        amount:            parsed.data.amount,
        reference_date:    parsed.data.cost_date,
        company_id:        user.company_id,
        marketing_cost_id: costId,
        created_by:        user.id,
      })

    if (feError) return NextResponse.json({ error: feError.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  // Fase 2 (revisão) — Marketing liberado para usuario (módulo completo).
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const id = Number(params.id)
  if (!id) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const admin = createAdminClient()

  // Remove finance_entry vinculada antes de deletar marketing_cost
  await (admin as any)
    .from('finance_entries')
    .delete()
    .eq('marketing_cost_id', id)
    .eq('company_id', user.company_id)

  const { error, count } = await (admin as any)
    .from('marketing_costs')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('company_id', user.company_id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!count) return NextResponse.json({ error: 'Custo não encontrado' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
