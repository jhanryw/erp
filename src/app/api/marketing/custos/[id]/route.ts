import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  category: z.enum(['paid_traffic','influencers','events','photos','gifts','packaging','rent','salaries','operational','taxes','other']),
  description: z.string().min(2),
  amount: z.coerce.number().positive(),
  cost_date: z.string().min(1),
  campaign_id: z.coerce.number().int().positive().nullable().optional(),
  is_recurring: z.boolean().default(false),
  notes: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
})

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const admin = createAdminClient()
  const { data, error } = (await admin.from('marketing_costs').select('*').eq('id', Number(params.id)).single()) as unknown as { data: any; error: any }
  if (error || !data) return NextResponse.json({ error: 'Custo não encontrado' }, { status: 404 })
  return NextResponse.json({ cost: data })
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = createAdminClient()
  const { error } = (await (admin as any).from('marketing_costs').update({ ...parsed.data, campaign_id: parsed.data.campaign_id ?? null }).eq('id', Number(params.id))) as { error: any }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
