import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { CheckCircle2 } from 'lucide-react'
import { getWholesaleCustomerSession } from '@/lib/wholesale/session'
import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { createAdminClient } from '@/lib/supabase/admin'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import { getWholesaleBasePath } from '@/lib/wholesale/requestContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Pedido' }

const STATUS_LABELS: Record<string, string> = {
  paid: 'Confirmado', delivered: 'Entregue', cancelled: 'Cancelado', returned: 'Devolvido',
}

export default async function PedidoPage({ params }: { params: { id: string } }) {
  const basePath = getWholesaleBasePath()
  const session = await getWholesaleCustomerSession()
  if (!session) {
    redirect(`${wholesaleHref(basePath, '/entrar')}?redirect=${encodeURIComponent(wholesaleHref(basePath, `/pedido/${params.id}`))}`)
  }

  const tenant = await resolveWholesaleSiteTenant()
  if (!tenant) notFound()

  const saleId = Number(params.id)
  if (!saleId) notFound()

  // Mesma checagem de posse da API — nunca confia em /pedido/[id] sem
  // validar customer_id/company_id (seção 40 do pedido).
  const admin = createAdminClient()
  const { data: sale } = await (admin as any)
    .from('sales')
    .select('id, sale_number, sale_date, status, total, subtotal, shipping_charged')
    .eq('id', saleId)
    .eq('company_id', tenant.companyId)
    .eq('customer_id', session.customerId)
    .eq('sales_channel', 'wholesale_site')
    .maybeSingle() as { data: any | null }

  if (!sale) notFound()

  const [{ data: items }, { data: shipment }] = await Promise.all([
    (admin as any)
      .from('sale_items')
      .select('id, quantity, unit_price, total_price, product_variations!inner(sku_variation, products!inner(name))')
      .eq('sale_id', saleId) as Promise<{ data: any[] | null }>,
    (admin as any).from('shipments').select('delivery_mode, status').eq('order_id', saleId).maybeSingle() as Promise<{ data: any | null }>,
  ])

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="text-center space-y-2 py-4">
        <CheckCircle2 className="w-12 h-12 text-success mx-auto" />
        <h1 className="text-2xl font-bold text-text-primary">Pedido {sale.sale_number} recebido!</h1>
        <p className="text-text-muted">Nosso time comercial vai entrar em contato para confirmar pagamento e entrega.</p>
      </div>

      <div className="rounded-xl border border-border bg-bg-card p-5 space-y-4">
        <div className="flex justify-between text-sm">
          <span className="text-text-secondary">Status</span>
          <span className="font-medium text-text-primary">{STATUS_LABELS[sale.status] ?? sale.status}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-text-secondary">Data</span>
          <span className="font-medium text-text-primary">{formatDate(sale.sale_date)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-text-secondary">Entrega</span>
          <span className="font-medium text-text-primary">{shipment?.delivery_mode === 'pickup' ? 'Retirada' : 'Entrega'}</span>
        </div>

        <div className="border-t border-border pt-3 space-y-2">
          {(items ?? []).map((i: any) => {
            const pv = Array.isArray(i.product_variations) ? i.product_variations[0] : i.product_variations
            const product = Array.isArray(pv?.products) ? pv.products[0] : pv?.products
            return (
              <div key={i.id} className="flex justify-between text-sm">
                <span className="text-text-secondary">{i.quantity}× {product?.name ?? 'Produto'}</span>
                <span className="font-medium text-text-primary tabular-nums">{formatCurrency(i.total_price)}</span>
              </div>
            )
          })}
        </div>

        <div className="border-t border-border pt-3 flex justify-between text-base font-bold text-text-primary">
          <span>Total</span>
          <span>{formatCurrency(sale.total)}</span>
        </div>

        <p className="text-xs text-text-muted">
          Pagamento: a combinar com nosso time comercial.
        </p>
      </div>

      <div className="flex gap-3 justify-center text-sm">
        <Link href={wholesaleHref(basePath, '/')} className="text-brand font-medium hover:underline">Continuar comprando</Link>
        <Link href={wholesaleHref(basePath, '/pedidos')} className="text-text-muted hover:text-text-primary">Ver meus pedidos</Link>
      </div>
    </div>
  )
}
