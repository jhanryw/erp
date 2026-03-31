export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { z } from 'zod'

const schemaCreate = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  state: z.string().default('RN'),
  city: z.string().optional(),
  neighborhoods_json: z.array(z.string()).optional(),
  cep_ranges_json: z.array(z.object({ min: z.string(), max: z.string() })).optional(),
  min_km: z.coerce.number().optional(),
  max_km: z.coerce.number().optional(),
  color: z.string().default('#3b82f6'),
  priority: z.coerce.number().default(100),
})

export async function GET() {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  try {
    const admin = createAdminClient()

    const { data: zones, error } = await (admin as any)
      .from('shipping_zones')
      .select('*, shipping_rules(*)')
      .eq('company_id', user.company_id)
      .order('priority', { ascending: true })

    if (error) throw error

    return NextResponse.json({ zones: zones || [] })
  } catch (error) {
    console.error('[API Admin Zones GET]', error)
    return NextResponse.json({ error: 'Erro ao buscar zonas' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  try {
    const body = await request.json()

    const parsed = schemaCreate.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
    }

    const admin = createAdminClient()

    const { data: zone, error } = await (admin as any)
      .from('shipping_zones')
      .insert({
        name: parsed.data.name,
        description: parsed.data.description,
        state: parsed.data.state,
        city: parsed.data.city,
        neighborhoods_json: parsed.data.neighborhoods_json || [],
        cep_ranges_json: parsed.data.cep_ranges_json || [],
        min_km: parsed.data.min_km,
        max_km: parsed.data.max_km,
        color: parsed.data.color,
        priority: parsed.data.priority,
        company_id: user.company_id,
      })
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ zone }, { status: 201 })
  } catch (error) {
    console.error('[API Admin Zones POST]', error)
    return NextResponse.json({ error: 'Erro ao criar zona' }, { status: 500 })
  }
}
