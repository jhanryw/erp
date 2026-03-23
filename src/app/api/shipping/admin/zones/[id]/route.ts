export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { z } from 'zod'

const schemaUpdate = z.object({
  name: z.string().min(2).optional(),
  description: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  neighborhoods_json: z.array(z.string()).optional(),
  cep_ranges_json: z.array(z.object({ min: z.string(), max: z.string() })).optional(),
  min_km: z.coerce.number().optional(),
  max_km: z.coerce.number().optional(),
  color: z.string().optional(),
  priority: z.coerce.number().optional(),
  is_active: z.boolean().optional(),
})

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const admin = createAdminClient()

    const { data: zone, error } = await admin
      .from('shipping_zones')
      .select('*, shipping_rules(*)')
      .eq('id', parseInt(params.id))
      .single()

    if (error) throw error
    if (!zone) return NextResponse.json({ error: 'Zona não encontrada' }, { status: 404 })

    return NextResponse.json({ zone })
  } catch (error) {
    console.error('[API Admin Zones GET]', error)
    return NextResponse.json({ error: 'Erro ao buscar zona' }, { status: 500 })
  }
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const body = await request.json()

    const parsed = schemaUpdate.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
    }

    const admin = createAdminClient()

    const { data: zone, error } = await admin
      .from('shipping_zones')
      .update(parsed.data)
      .eq('id', parseInt(params.id))
      .select()
      .single()

    if (error) throw error
    if (!zone) return NextResponse.json({ error: 'Zona não encontrada' }, { status: 404 })

    return NextResponse.json({ zone })
  } catch (error) {
    console.error('[API Admin Zones PATCH]', error)
    return NextResponse.json({ error: 'Erro ao atualizar zona' }, { status: 500 })
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try {
    const admin = createAdminClient()

    const { error } = await admin.from('shipping_zones').delete().eq('id', parseInt(params.id))

    if (error) throw error

    return NextResponse.json({ message: 'Zona deletada com sucesso' })
  } catch (error) {
    console.error('[API Admin Zones DELETE]', error)
    return NextResponse.json({ error: 'Erro ao deletar zona' }, { status: 500 })
  }
}
