export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'

export async function GET() {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) {
    return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  }

  const admin = createAdminClient()

  const { data, error } = await (admin as any)
    .from('shipments')
    .select(`
      id,
      order_id,
      delivery_mode,
      status,
      motoboy,
      courier_phone,
      internal_cost,
      internal_cost_real,
      repasse_status,
      repasse_amount,
      repasse_paid_at,
      repasse_batch_id,
      repasse_finance_entry_id,
      created_at,
      sales:order_id (
        sale_number,
        shipping_charged
      ),
      customers:customer_id (
        name
      ),
      customer_addresses:address_id (
        neighborhood,
        city
      ),
      shipping_zones:zone_id (
        name,
        color
      ),
      shipping_rules:rule_id (
        client_price,
        internal_cost
      )
    `)
    .eq('company_id', user.company_id)
    .eq('delivery_mode', 'delivery')
    .order('created_at', { ascending: false }) as unknown as {
      data: unknown[] | null
      error: { message: string } | null
    }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ shipments: data ?? [] })
}
