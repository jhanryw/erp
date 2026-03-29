export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { z } from 'zod'

const schemaUpdate = z.object({
  rule_type: z.string().optional(),
  client_price: z.coerce.number().optional(),
  internal_cost: z.coerce.number().optional(),
  estimated_hours: z.coerce.number().optional(),
  free_shipping_min_order: z.coerce.number().optional(),
  min_order_to_enable: z.coerce.number().optional(),
  allow_pickup: z.boolean().optional(),
  allow_delivery: z.boolean().optional(),
  is_active: z.boolean().optional(),
})

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const admin = createAdminClient()

    const { data: rule, error } = await (admin as any)
      .from('shipping_rules')
      .select('*')
      .eq('id', parseInt(params.id))
      .single()

    if (error) throw error
    if (!rule) return NextResponse.json({ error: 'Regra não encontrada' }, { status: 404 })

    return NextResponse.json({ rule })
  } catch (error) {
    console.error('[API Admin Rules GET]', error)
    return NextResponse.json({ error: 'Erro ao buscar regra' }, { status: 500 })
  }
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const { response: unauth } = await requireRole('admin')
  if (unauth) return unauth

  try {
    const body = await request.json()

    const parsed = schemaUpdate.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
    }

    const admin = createAdminClient()

    const { data: rule, error } = await (admin as any)
      .from('shipping_rules')
      .update(parsed.data)
      .eq('id', parseInt(params.id))
      .select()
      .single()

    if (error) throw error
    if (!rule) return NextResponse.json({ error: 'Regra não encontrada' }, { status: 404 })

    return NextResponse.json({ rule })
  } catch (error) {
    console.error('[API Admin Rules PATCH]', error)
    return NextResponse.json({ error: 'Erro ao atualizar regra' }, { status: 500 })
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const { response: unauth } = await requireRole('admin')
  if (unauth) return unauth

  try {
    const admin = createAdminClient()

    const { error } = await (admin as any).from('shipping_rules').delete().eq('id', parseInt(params.id))

    if (error) throw error

    return NextResponse.json({ message: 'Regra deletada com sucesso' })
  } catch (error) {
    console.error('[API Admin Rules DELETE]', error)
    return NextResponse.json({ error: 'Erro ao deletar regra' }, { status: 500 })
  }
}
