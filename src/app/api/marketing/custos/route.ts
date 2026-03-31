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
  const { error } = await admin.from('marketing_costs').insert({
    ...parsed.data,
    campaign_id: parsed.data.campaign_id ?? null,
    created_by: user.id,
    company_id: user.company_id,
  } as any)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true }, { status: 201 })
}
