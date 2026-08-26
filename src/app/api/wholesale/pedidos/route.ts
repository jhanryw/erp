export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { getWholesaleCustomerSession } from '@/lib/wholesale/session'

/** Lista SÓ os pedidos do cliente autenticado (seção 40 do pedido — nunca vendas de outro cliente/empresa). */
export async function GET() {
  const tenant = await resolveWholesaleSiteTenant()
  if (!tenant) return NextResponse.json({ error: 'Site de atacado não configurado.' }, { status: 503 })

  const session = await getWholesaleCustomerSession()
  if (!session) return NextResponse.json({ error: 'Faça login.' }, { status: 401 })

  const admin = createAdminClient()
  const { data } = await (admin as any)
    .from('sales')
    .select('id, sale_number, sale_date, status, total')
    .eq('company_id', tenant.companyId)
    .eq('customer_id', session.customerId)
    .eq('sales_channel', 'wholesale_site')
    .order('sale_date', { ascending: false })
    .limit(50) as { data: any[] | null }

  return NextResponse.json({ orders: data ?? [] })
}
