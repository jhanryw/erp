import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { requirePageRole } from '@/lib/auth/requirePageRole'
import { Card } from '@/components/ui/card'
import { formatCurrency } from '@/lib/utils/currency'
import { listChannelOrders } from '@/services/channels/channelOrders.service'
import { ReprocessOrderButton } from '@/components/channels/reprocess-order-button'

const STATE_LABEL: Record<string, string> = {
  pending: 'Recebido', awaiting_payment: 'Aguardando pagamento', needs_attention: 'Precisa de atenção',
  imported: 'Venda criada', cancelled: 'Cancelado', ignored: 'Ignorado',
}
const STATE_CLASS: Record<string, string> = {
  needs_attention: 'bg-warning/15 text-warning', imported: 'bg-success/15 text-success',
  cancelled: 'bg-bg-overlay text-text-muted', awaiting_payment: 'bg-info/15 text-info',
}
const FILTERS = ['needs_attention', 'awaiting_payment', 'imported', 'cancelled'] as const

/**
 * Pedidos de marketplace (channel_orders) da empresa: o que virou venda e,
 * principalmente, o que precisa de atenção (sem estoque, sem vínculo…),
 * com reprocessamento manual. Sem payload técnico.
 */
export default async function MarketplaceOrdersPage({ searchParams }: { searchParams: { estado?: string } }) {
  const profile = await requirePageRole('gerente')
  const state = FILTERS.includes(searchParams.estado as (typeof FILTERS)[number]) ? searchParams.estado! : null
  const orders = profile.company_id ? await listChannelOrders(profile.company_id, state) : []

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/vendas" className="text-text-muted hover:text-text-primary" aria-label="Voltar"><ArrowLeft className="h-5 w-5" /></Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pedidos de marketplace</h1>
          <p className="text-sm text-muted-foreground">Pedidos recebidos do Mercado Livre e o que virou venda no Qarvon.</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <Link href="/vendas/marketplace" className={`rounded-full border px-2.5 py-1 ${!state ? 'border-brand bg-brand/10 text-brand' : 'border-border'}`}>Todos</Link>
        {FILTERS.map((f) => (
          <Link key={f} href={`/vendas/marketplace?estado=${f}`}
            className={`rounded-full border px-2.5 py-1 ${state === f ? 'border-brand bg-brand/10 text-brand' : 'border-border'}`}>
            {STATE_LABEL[f]}
          </Link>
        ))}
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-muted">
                <th className="px-4 py-2">Pedido</th>
                <th className="px-4 py-2">Situação</th>
                <th className="px-4 py-2 text-right">Bruto</th>
                <th className="px-4 py-2 text-right">Tarifa</th>
                <th className="px-4 py-2 text-right">Frete vendedor</th>
                <th className="px-4 py-2 text-right">Líquido previsto</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-text-muted">Nenhum pedido.</td></tr>
              )}
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-border/60 align-top">
                  <td className="px-4 py-2">
                    <span className="rounded-full bg-[#FFE600] px-2 py-0.5 text-xs font-semibold text-[#2D3277]">Mercado Livre</span>
                    <span className="ml-2 font-mono text-xs">{o.external_order_id}</span>
                    {o.is_test && <span className="ml-1 rounded bg-info/15 px-1 text-xs text-info">TEST</span>}
                    {o.created_at_external && <p className="text-xs text-text-muted">{new Date(o.created_at_external).toLocaleString('pt-BR')}</p>}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs ${STATE_CLASS[o.processing_state] ?? 'bg-bg-overlay'}`}>{STATE_LABEL[o.processing_state] ?? o.processing_state}</span>
                    {o.attention_reason && <p className="mt-1 max-w-md text-xs text-warning">{o.attention_reason}</p>}
                    {o.sale_id && <Link href={`/vendas/${o.sale_id}`} className="mt-1 block text-xs text-brand hover:underline">Ver venda</Link>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{o.gross_amount != null ? formatCurrency(o.gross_amount) : '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{o.marketplace_fees != null ? formatCurrency(o.marketplace_fees) : '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{o.shipping_cost_seller != null ? formatCurrency(o.shipping_cost_seller) : '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{o.net_amount != null ? formatCurrency(o.net_amount) : '—'}</td>
                  <td className="px-4 py-2 text-right">
                    {o.processing_state !== 'cancelled' && <ReprocessOrderButton channelOrderId={o.id} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
