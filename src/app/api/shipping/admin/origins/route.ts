export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { z } from 'zod'

const schemaCreate = z.object({
  name: z.string().min(2),
  cep: z.string().min(5),
  street: z.string().min(2),
  number: z.string().optional(),
  complement: z.string().optional(),
  neighborhood: z.string().min(2),
  city: z.string().min(2),
  state: z.string().length(2),
  latitude: z.coerce.number(),
  longitude: z.coerce.number(),
})

export async function GET() {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  try {
    const admin = createAdminClient()

    const { data: origins, error } = await (admin as any)
      .from('shipping_origins')
      .select('*')
      .eq('company_id', user.company_id)
      .order('is_active', { ascending: false })

    if (error) throw error

    return NextResponse.json({ origins: origins || [] })
  } catch (error) {
    console.error('[API Admin Origins GET]', error)
    return NextResponse.json({ error: 'Erro ao buscar origens' }, { status: 500 })
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

    const { data: origin, error } = await (admin as any)
      .from('shipping_origins')
      .insert({
        name: parsed.data.name,
        cep: parsed.data.cep,
        street: parsed.data.street,
        number: parsed.data.number,
        complement: parsed.data.complement,
        neighborhood: parsed.data.neighborhood,
        city: parsed.data.city,
        state: parsed.data.state,
        latitude: parsed.data.latitude,
        longitude: parsed.data.longitude,
        company_id: user.company_id,
      })
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ origin }, { status: 201 })
  } catch (error) {
    console.error('[API Admin Origins POST]', error)
    return NextResponse.json({ error: 'Erro ao criar origem' }, { status: 500 })
  }
}
