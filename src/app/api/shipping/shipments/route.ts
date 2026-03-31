export const dynamic = 'force-dynamic'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'

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
