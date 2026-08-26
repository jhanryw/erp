export const dynamic = 'force-dynamic'

/**
 * GET /api/wholesale/pedidos/[id] — Fase 8, seção 40 do pedido.
 *
 * "Nunca confiar em /pedido/123 sem autorização" — a query abaixo SEMPRE
 * filtra por `customer_id = session.customerId` E `company_id =
 * tenant.companyId` simultaneamente. Pedido de outro cliente (mesma
 * empresa) ou de outra empresa nunca é encontrado — devolve 404, nunca
 * um 403 que confirmaria a existência do pedido pra quem não deveria ver.
 */

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { getWholesaleCustomerSession } from '@/lib/wholesale/session'

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const tenant = await resolveWholesaleSiteTenant()
  if (!tenant) return NextResponse.json({ error: 'Site de atacado não configurado.' }, { status: 503 })

  const session = await getWholesaleCustomerSession()
  if (!session) return NextResponse.json({ error: 'Faça login.' }, { status: 401 })

  const saleId = Number(params.id)
  if (!saleId || !Number.isInteger(saleId)) return NextResponse.json({ error: 'Pedido inválido.' }, { status: 400 })

  const admin = createAdminClient()
  const { data: sale } = await (admin as any)
    .from('sales')
    .select('id, sale_number, sale_date, status, total, subtotal, shipping_charged')
    .eq('id', saleId)
    .eq('company_id', tenant.companyId)
    .eq('customer_id', session.customerId)
    .eq('sales_channel', 'wholesale_site')
    .maybeSingle() as { data: any | null }

  if (!sale) return NextResponse.json({ error: 'Pedido não encontrado.' }, { status: 404 })

  const { data: items } = await (admin as any)
    .from('sale_items')
    .select('id, quantity, unit_price, total_price, product_variations!inner(sku_variation, products!inner(name))')
    .eq('sale_id', saleId) as { data: any[] | null }

  const { data: shipment } = await (admin as any)
    .from('shipments')
    .select('delivery_mode, status')
    .eq('order_id', saleId)
    .maybeSingle() as { data: any | null }

  return NextResponse.json({
    order: {
      id: sale.id,
      sale_number: sale.sale_number,
      sale_date: sale.sale_date,
      status: sale.status,
      total: sale.total,
      subtotal: sale.subtotal,
      shipping_charged: sale.shipping_charged,
      delivery_mode: shipment?.delivery_mode ?? null,
      shipment_status: shipment?.status ?? null,
      items: (items ?? []).map((i: any) => {
        const pv = Array.isArray(i.product_variations) ? i.product_variations[0] : i.product_variations
        const product = Array.isArray(pv?.products) ? pv.products[0] : pv?.products
        return {
          id: i.id,
          product_name: product?.name ?? 'Produto',
          sku: pv?.sku_variation ?? null,
          quantity: i.quantity,
          unit_price: i.unit_price,
          total_price: i.total_price,
        }
      }),
    },
  })
}
