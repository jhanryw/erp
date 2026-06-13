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

  // Busca shipments sem join a sales (order_id não segue convenção <table>_id)
  const { data: shipments, error } = await (admin as any)
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
      data: Array<Record<string, unknown>> | null
      error: { message: string } | null
    }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = shipments ?? []

  // Busca separada para sale_number + shipping_charged usando os order_ids
  const orderIds = [...new Set(rows.map(s => s.order_id).filter(Boolean))]

  let salesMap: Record<number, { sale_number: string; shipping_charged: number }> = {}

  if (orderIds.length > 0) {
    const { data: salesData } = await (admin as any)
      .from('sales')
      .select('id, sale_number, shipping_charged')
      .in('id', orderIds) as unknown as {
        data: Array<{ id: number; sale_number: string; shipping_charged: number }> | null
      }

    for (const s of salesData ?? []) {
      salesMap[s.id] = { sale_number: s.sale_number, shipping_charged: s.shipping_charged }
    }
  }

  // Mescla dados de sales em cada shipment
  const result = rows.map(s => ({
    ...s,
    sales: salesMap[s.order_id as number] ?? null,
  }))

  return NextResponse.json({ shipments: result })
}
