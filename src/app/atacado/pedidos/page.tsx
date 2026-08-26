import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getWholesaleCustomerSession } from '@/lib/wholesale/session'
import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { createAdminClient } from '@/lib/supabase/admin'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import { getWholesaleBasePath } from '@/lib/wholesale/requestContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Meus pedidos' }

const STATUS_LABELS: Record<string, string> = {
  paid: 'Confirmado', delivered: 'Entregue', cancelled: 'Cancelado', returned: 'Devolvido',
}

export default async function PedidosPage() {
  const basePath = getWholesaleBasePath()
  const session = await getWholesaleCustomerSession()
  if (!session) {
    redirect(`${wholesaleHref(basePath, '/entrar')}?redirect=${encodeURIComponent(wholesaleHref(basePath, '/pedidos'))}`)
  }

  const tenant = await resolveWholesaleSiteTenant()
  if (!tenant) redirect(wholesaleHref(basePath, '/'))

  const admin = createAdminClient()
  const { data: orders } = await (admin as any)
    .from('sales')
    .select('id, sale_number, sale_date, status, total')
    .eq('company_id', tenant.companyId)
    .eq('customer_id', session.customerId)
    .eq('sales_channel', 'wholesale_site')
    .order('sale_date', { ascending: false })
    .limit(50) as { data: any[] | null }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-text-primary">Meus pedidos</h1>

      {(!orders || orders.length === 0) ? (
        <p className="text-text-muted text-center py-10">Você ainda não fez nenhum pedido.</p>
      ) : (
        <div className="space-y-2">
          {orders.map((o) => (
            <Link
              key={o.id}
              href={wholesaleHref(basePath, `/pedido/${o.id}`)}
              className="flex items-center justify-between p-4 rounded-xl border border-border bg-bg-card hover:border-brand/40 transition-colors"
            >
              <div>
                <p className="text-sm font-semibold text-text-primary">{o.sale_number}</p>
                <p className="text-xs text-text-muted">{formatDate(o.sale_date)} · {STATUS_LABELS[o.status] ?? o.status}</p>
              </div>
              <span className="text-sm font-bold text-text-primary">{formatCurrency(o.total)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
