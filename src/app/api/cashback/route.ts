export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  rate_pct: z.coerce.number().min(0.01).max(100),
  min_order_value: z.coerce.number().min(0),
  release_days: z.coerce.number().int().min(0),
  expiry_days: z.coerce.number().int().min(1),
  min_use_value: z.coerce.number().min(0),
  active: z.boolean().default(true),
})

export async function GET() {
  const { response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('cashback_config')
    .select('*')
    .eq('active', true)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ config: data })
}

export async function POST(request: Request) {
  // Configuração de cashback altera regras de negócio — exige admin
  const { response: unauth } = await requireRole('admin')
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = createAdminClient()

  // Verificar se já existe config ativa
  const { data: existing } = await admin
    .from('cashback_config')
    .select('id')
    .eq('active', true)
    .maybeSingle() as unknown as { data: { id: number } | null }

  if (existing) {
    const { error } = (await (admin as any)
      .from('cashback_config')
      .update({ ...parsed.data, updated_by: null })
      .eq('id', existing.id)) as { error: any }
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const { error } = (await (admin as any)
      .from('cashback_config')
      .insert({ ...parsed.data, updated_by: null })) as { error: any }
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
