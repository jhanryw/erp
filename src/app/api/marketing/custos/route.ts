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

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = createAdminClient()

  const { data: cost, error } = await (admin as any)
    .from('marketing_costs')
    .insert({
      ...parsed.data,
      campaign_id: parsed.data.campaign_id ?? null,
      created_by: user.id,
      company_id: user.company_id,
    })
    .select('id')
    .single() as { data: { id: number } | null; error: { message: string } | null }

  if (error || !cost) return NextResponse.json({ error: error?.message ?? 'Erro ao criar custo.' }, { status: 500 })

  // Lançamento financeiro vinculado — mantém DRE e dashboard atualizados
  const { error: feError } = await (admin as any)
    .from('finance_entries')
    .insert({
      type:              'expense',
      category:          'marketing',
      description:       parsed.data.description,
      amount:            parsed.data.amount,
      reference_date:    parsed.data.cost_date,
      company_id:        user.company_id,
      marketing_cost_id: cost.id,
      created_by:        user.id,
    })

  if (feError) return NextResponse.json({ error: feError.message }, { status: 500 })

  return NextResponse.json({ ok: true }, { status: 201 })
}
