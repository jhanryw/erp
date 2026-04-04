export const dynamic = 'force-dynamic'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'
import { z } from 'zod'

export async function GET() {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('shipments')
    .select(`
      *,
      customers:customer_id (id, name, phone),
      customer_addresses:address_id (street, number, neighborhood, city, cep),
      shipping_zones:zone_id (name, color),
      shipping_rules:rule_id (client_price, internal_cost)
    `)
    .eq('company_id', user.company_id)
    .order('created_at', { ascending: false })
    .limit(100) as unknown as { data: any[] | null; error: any }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ shipments: data ?? [] })
}

const postSchema = z.object({
  sale_id:       z.number().int().positive(),
  customer_id:   z.number().int().positive(),
  delivery_mode: z.enum(['pickup', 'delivery']).default('delivery'),
  notes:         z.string().nullable().optional(),
})

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = postSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const { sale_id, customer_id, delivery_mode, notes } = parsed.data
  const status = delivery_mode === 'pickup' ? 'aguardando_retirada' : 'aguardando_confirmacao'

  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('shipments')
    .insert({
      order_id:      sale_id,
      customer_id,
      delivery_mode,
      status,
      notes:         notes ?? null,
      company_id:    user.company_id,
    })
    .select('id, status, delivery_mode')
    .single() as unknown as { data: any; error: any }

  if (error) {
    // Conflito: já existe shipment para esta venda
    if (error.code === '23505') return NextResponse.json({ error: 'Envio já registrado para esta venda.' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ shipment: data }, { status: 201 })
}
