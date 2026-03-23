export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { z } from 'zod'

const schemaCreate = z.object({
  zone_id: z.coerce.number(),
  rule_type: z.string().default('zone'),
  client_price: z.coerce.number(),
  internal_cost: z.coerce.number(),
  estimated_hours: z.coerce.number().default(24),
  free_shipping_min_order: z.coerce.number().optional(),
  min_order_to_enable: z.coerce.number().optional(),
  allow_pickup: z.boolean().default(false),
  allow_delivery: z.boolean().default(true),
})

export async function GET(request: Request) {
  try {
    const admin = createAdminClient()

    const { searchParams } = new URL(request.url)
    const zoneId = searchParams.get('zone_id')

    let query = admin.from('shipping_rules').select('*')

    if (zoneId) {
      query = query.eq('zone_id', parseInt(zoneId))
    }

    const { data: rules, error } = await query.order('zone_id', { ascending: true })

    if (error) throw error

    return NextResponse.json({ rules: rules || [] })
  } catch (error) {
    console.error('[API Admin Rules GET]', error)
    return NextResponse.json({ error: 'Erro ao buscar regras' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()

    const parsed = schemaCreate.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
    }

    const admin = createAdminClient()

    const { data: rule, error } = await admin
      .from('shipping_rules')
      .insert({
        zone_id: parsed.data.zone_id,
        rule_type: parsed.data.rule_type,
        client_price: parsed.data.client_price,
        internal_cost: parsed.data.internal_cost,
        estimated_hours: parsed.data.estimated_hours,
        free_shipping_min_order: parsed.data.free_shipping_min_order,
        min_order_to_enable: parsed.data.min_order_to_enable,
        allow_pickup: parsed.data.allow_pickup,
        allow_delivery: parsed.data.allow_delivery,
      })
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ rule }, { status: 201 })
  } catch (error) {
    console.error('[API Admin Rules POST]', error)
    return NextResponse.json({ error: 'Erro ao criar regra' }, { status: 500 })
  }
}
