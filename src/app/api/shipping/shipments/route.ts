export const dynamic = 'force-dynamic'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

export async function GET() {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('shipments')
    .select(`
      *,
      customers:customer_id (id, name, phone),
      customer_addresses:address_id (street, number, neighborhood, city, cep),
      shipping_zones:zone_id (name, color),
      shipping_rules:rule_id (client_price, internal_cost)
    `)
    .order('created_at', { ascending: false })
    .limit(100) as unknown as { data: any[] | null; error: any }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ shipments: data ?? [] })
}
