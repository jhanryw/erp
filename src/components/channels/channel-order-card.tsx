import { Card } from '@/components/ui/card'
import { formatCurrency } from '@/lib/utils/currency'

export interface ChannelOrderSummary {
  provider: string
  external_order_id: string
  external_pack_id: string | null
  external_shipment_id: string | null
  channel_status: string | null
  payment_status: string | null
  shipping_status: string | null
  shipping_mode: string | null
  tracking_number: string | null
  processing_state: string
  attention_reason: string | null
  gross_amount: number | null
  marketplace_fees: number | null
  shipping_cost_seller: number | null
  other_costs: number | null
  net_amount: number | null
  money_release_date: string | null
  is_test: boolean
  account_nickname: string | null
}

const PROVIDER_LABEL: Record<string, string> = { mercadolivre: 'Mercado Livre' }

const ORDER_STATUS: Record<string, string> = {
  paid: 'Pago', confirmed: 'Confirmado (sem pagamento)', payment_required: 'Aguardando pagamento',
  payment_in_process: 'Pagamento em processamento', partially_paid: 'Parcialmente pago',
  partially_refunded: 'Reembolso parcial', pending_cancel: 'Cancelamento pendente', cancelled: 'Cancelado', invalid: 'Inválido',
}

const money = (v: number | null) => (v == null ? '—' : formatCurrency(Number(v)))

/**
 * Pedido do marketplace que originou a venda. Mostra identificação e a
 * decomposição financeira REAL (bruto × tarifa × frete do vendedor ×
 * líquido previsto) — nunca o payload técnico.
 */
export function ChannelOrderCard({ order }: { order: ChannelOrderSummary }) {
  const label = PROVIDER_LABEL[order.provider] ?? order.provider
  const fees = Number(order.marketplace_fees ?? 0)
  const ship = Number(order.shipping_cost_seller ?? 0)
  const other = Number(order.other_costs ?? 0)
  return (
    <Card padding="md">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <span className="rounded-full bg-[#FFE600] px-2 py-0.5 text-xs font-semibold text-[#2D3277]">{label}</span>
          Pedido {order.external_order_id}
          {order.is_test && <span className="rounded bg-info/15 px-1.5 text-xs text-info">TEST</span>}
        </h3>
        {order.account_nickname && <span className="text-xs text-text-muted">Conta {order.account_nickname}</span>}
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex justify-between"><dt className="text-text-muted">Status no canal</dt><dd>{ORDER_STATUS[order.channel_status ?? ''] ?? order.channel_status ?? '—'}</dd></div>
        <div className="flex justify-between"><dt className="text-text-muted">Envio</dt><dd>{[order.shipping_mode, order.shipping_status].filter(Boolean).join(' · ') || '—'}</dd></div>
        {order.external_pack_id && <div className="flex justify-between"><dt className="text-text-muted">Pacote</dt><dd className="font-mono text-xs">{order.external_pack_id}</dd></div>}
        {order.tracking_number && <div className="flex justify-between"><dt className="text-text-muted">Rastreio</dt><dd className="font-mono text-xs">{order.tracking_number}</dd></div>}
      </dl>

      <div className="mt-4 space-y-1 border-t border-border pt-3 text-sm">
        <div className="flex justify-between"><span>Venda bruta</span><span className="font-semibold tabular-nums">{money(order.gross_amount)}</span></div>
        <div className="flex justify-between text-text-secondary"><span>Tarifa {label}</span><span className="tabular-nums">− {money(fees)}</span></div>
        <div className="flex justify-between text-text-secondary">
          <span>Frete / custos do vendedor</span>
          <span className="tabular-nums">{order.shipping_cost_seller == null ? 'aguardando o canal' : `− ${money(ship + other)}`}</span>
        </div>
        <div className="flex justify-between border-t border-border pt-1 font-semibold">
          <span>Líquido previsto</span><span className="tabular-nums">{money(order.net_amount)}</span>
        </div>
        <p className="text-xs text-text-muted">
          {order.money_release_date
            ? `Liberação prevista: ${new Date(order.money_release_date).toLocaleDateString('pt-BR')}`
            : 'Liberação prevista: ainda não informada pelo canal.'}
          {' '}O faturamento da venda é o valor bruto; tarifas e frete são despesas separadas.
        </p>
      </div>

      {order.processing_state === 'cancelled' && (
        <p className="mt-3 text-xs text-warning">Pedido cancelado no canal — venda cancelada e custos estornados.</p>
      )}
      {order.attention_reason && order.processing_state !== 'cancelled' && (
        <p className="mt-3 text-xs text-warning">{order.attention_reason}</p>
      )}
    </Card>
  )
}
