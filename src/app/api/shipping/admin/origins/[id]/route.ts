export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { z } from 'zod'

const schemaUpdate = z.object({
  name: z.string().min(2).optional(),
  cep: z.string().min(5).optional(),
  street: z.string().min(2).optional(),
  number: z.string().optional(),
  complement: z.string().optional(),
  neighborhood: z.string().min(2).optional(),
  city: z.string().min(2).optional(),
  state: z.string().length(2).optional(),
  latitude: z.coerce.number().optional(),
  longitude: z.coerce.number().optional(),
  is_active: z.boolean().optional(),
})

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const admin = createAdminClient()

    const { data: origin, error } = await (admin as any)
      .from('shipping_origins')
      .select('*')
      .eq('id', parseInt(params.id))
      .single()

    if (error) throw error
    if (!origin) return NextResponse.json({ error: 'Origem não encontrada' }, { status: 404 })

    return NextResponse.json({ origin })
  } catch (error) {
    console.error('[API Admin Origins GET]', error)
    return NextResponse.json({ error: 'Erro ao buscar origem' }, { status: 500 })
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

    const { data: origin, error } = await (admin as any)
      .from('shipping_origins')
      .update(parsed.data)
      .eq('id', parseInt(params.id))
      .select()
      .single()

    if (error) throw error
    if (!origin) return NextResponse.json({ error: 'Origem não encontrada' }, { status: 404 })

    return NextResponse.json({ origin })
  } catch (error) {
    console.error('[API Admin Origins PATCH]', error)
    return NextResponse.json({ error: 'Erro ao atualizar origem' }, { status: 500 })
  }
}
