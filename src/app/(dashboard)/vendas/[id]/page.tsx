import { createAdminClient } from '@/lib/supabase/admin'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Package, Truck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { SaleStatusBadge } from '@/components/ui/badge'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import { cn } from '@/lib/utils/cn'
import { ReturnButton } from './_components/return-button'
import { CancelSaleButton } from './_components/cancel-sale-button'
import type { SaleStatus } from '@/types/database.types'

export const dynamic = 'force-dynamic'

const STATUS_STEPS: SaleStatus[] = ['pending', 'paid', 'shipped', 'delivered']

// Labels para pedidos de ENVIO (padrão)
const STATUS_LABELS_DELIVERY: Record<string, string> = {
  pending:  'Pedido Realizado',
  paid:     'Pago',
  shipped:  'Enviado',
  delivered: 'Entregue',
  cancelled: 'Cancelado',
  returned:  'Devolvido',
}

// Labels para pedidos de RETIRADA
const STATUS_LABELS_PICKUP: Record<string, string> = {
  pending:  'Pedido Realizado',
  paid:     'Pago',
  shipped:  'Pronto p/ Retirada',
  delivered: 'Retirado',
  cancelled: 'Cancelado',
  returned:  'Devolvido',
}

const PAYMENT_LABELS: Record<string, string> = {
  pix:         'PIX',
  card:        'Cartão',
  cash:        'Dinheiro',
  credit_card: 'Crédito',
  debit_card:  'Débito',
}

const SHIPMENT_STATUS_LABELS: Record<string, string> = {
  aguardando_confirmacao: 'Aguardando confirmação de endereço',
  aguardando_retirada:    'Aguardando retirada',
  em_transito:            'Em trânsito',
  entregue:               'Entregue',
  nao_entregue:           'Não entregue',
  cancelado:              'Cancelado',
}

async function getSale(id: string) {
  const admin = createAdminClient()
  const { data: sale } = await admin
    .from('sales')
    .select(`
      *,
      customers (id, name, cpf, phone),
      users (name),
      sale_items (
        id, quantity, unit_price, total_price, unit_cost,
        product_variations (
          id, sku_variation,
          products (id, name, sku),
          product_variation_attributes (
            variation_types:variation_type_id ( name, slug ),
            variation_values:variation_value_id ( value )
          )
        )
      )
    `)
    .eq('id', Number(id))
    .single() as unknown as { data: any }

  if (!sale) return null

  // Buscar envio vinculado a esta venda
  const { data: shipment } = await (admin as any)
    .from('shipments')
    .select('id, delivery_mode, status, notes')
    .eq('order_id', Number(id))
    .maybeSingle() as unknown as { data: { id: number; delivery_mode: string; status: string; notes: string | null } | null }

  // Buscar pagamentos detalhados (sale_payments) — vazio para vendas legadas
  const { data: salePayments } = await (admin as any)
    .from('sale_payments')
    .select('id, method, amount_tendered, change_amount, change_method, net_amount, installments, card_brand, acquirer, fee_amount')
    .eq('sale_id', Number(id))
    .order('net_amount', { ascending: false }) as unknown as {
      data: {
        id: number
        method: string
        amount_tendered: number
        change_amount: number
        change_method: string | null
        net_amount: number
        installments: number
        card_brand: string | null
        acquirer: string | null
        fee_amount: number
      }[] | null
    }

  return { ...sale, shipment: shipment ?? null, salePayments: salePayments ?? [] }
}

export default async function VendaDetalhePage({ params }: { params: { id: string } }) {
  const sale = await getSale(params.id)
  if (!sale) notFound()

  const isTerminal = sale.status === 'cancelled' || sale.status === 'returned'
  const canReturn = sale.status === 'delivered' || sale.status === 'paid'
  const currentStepIndex = STATUS_STEPS.indexOf(sale.status as SaleStatus)

  const isPickup = sale.shipment?.delivery_mode === 'pickup'
  const statusLabels = isPickup ? STATUS_LABELS_PICKUP : STATUS_LABELS_DELIVERY

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link href="/vendas">
            <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-text-primary font-mono">{sale.sale_number}</h2>
              <SaleStatusBadge status={sale.status as SaleStatus} />
              {sale.shipment && (
                <span className={cn(
                  'inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium',
                  isPickup
                    ? 'bg-purple-500/15 text-purple-400 border border-purple-500/20'
                    : 'bg-blue-500/15 text-blue-400 border border-blue-500/20'
                )}>
                  {isPickup
                    ? <><Package className="w-3 h-3" /> Retirada</>
                    : <><Truck className="w-3 h-3" /> Envio</>
                  }
                </span>
              )}
            </div>
            <p className="text-sm text-text-muted mt-0.5">
              {formatDate(sale.sale_date)}
              {' · '}
              <Link href={`/clientes/${sale.customers?.id}`} className="hover:text-text-secondary transition-colors">
                {sale.customers?.name ?? '—'}
              </Link>
              {' · '}
              {PAYMENT_LABELS[sale.payment_method] ?? sale.payment_method}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {canReturn && <ReturnButton saleId={sale.id} />}
          {!isTerminal && <CancelSaleButton saleId={sale.id} />}
        </div>
      </div>

      {/* Status Timeline */}
      {!isTerminal ? (
        <Card padding="md">
          <h3 className="text-sm font-semibold text-text-primary mb-5">Status do Pedido</h3>
          <div className="flex items-start">
            {STATUS_STEPS.map((step, i) => {
              const done = currentStepIndex >= i
              const current = currentStepIndex === i
              return (
                <div key={step} className="flex-1 flex flex-col items-center">
                  <div className="flex items-center w-full">
                    {i > 0 && (
                      <div className={cn('h-0.5 flex-1', done ? 'bg-brand' : 'bg-bg-overlay')} />
                    )}
                    <div className={cn(
                      'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0',
                      done ? 'bg-brand text-white' : 'bg-bg-overlay text-text-muted'
                    )}>
                      {i + 1}
                    </div>
                    {i < STATUS_STEPS.length - 1 && (
                      <div className={cn('h-0.5 flex-1', currentStepIndex > i ? 'bg-brand' : 'bg-bg-overlay')} />
                    )}
                  </div>
                  <span className={cn(
                    'text-[11px] mt-2 text-center leading-tight',
                    current ? 'text-brand font-semibold' : done ? 'text-text-secondary' : 'text-text-muted'
                  )}>
                    {statusLabels[step]}
                  </span>
                </div>
              )
            })}
          </div>

          {/* Shipment status detail */}
          {sale.shipment && (
            <div className={cn(
              'mt-5 pt-4 border-t border-border flex items-center gap-2 text-sm',
            )}>
              {isPickup
                ? <Package className="w-4 h-4 text-purple-400 flex-shrink-0" />
                : <Truck className="w-4 h-4 text-blue-400 flex-shrink-0" />
              }
              <span className="text-text-muted">Status do envio:</span>
              <span className={cn(
                'font-medium',
                sale.shipment.status === 'aguardando_retirada' ? 'text-purple-400' :
                sale.shipment.status === 'aguardando_confirmacao' ? 'text-yellow-400' :
                sale.shipment.status === 'em_transito' ? 'text-blue-400' :
                sale.shipment.status === 'entregue' ? 'text-success' :
                sale.shipment.status === 'nao_entregue' ? 'text-error' :
                'text-text-secondary'
              )}>
                {SHIPMENT_STATUS_LABELS[sale.shipment.status] ?? sale.shipment.status}
              </span>
            </div>
          )}
        </Card>
      ) : (
        <Card padding="md">
          <p className="text-sm text-text-secondary">
            Este pedido foi <span className="font-semibold text-text-primary">{statusLabels[sale.status]}</span>.
          </p>
        </Card>
      )}

      {/* Items */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">Itens do Pedido</h3>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Produto</TableHead>
              <TableHead>Variação</TableHead>
              <TableHead align="right">Qtd</TableHead>
              <TableHead align="right">Unit.</TableHead>
              <TableHead align="right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(sale.sale_items ?? []).map((item: any) => {
              const pv = item.product_variations
              const attrs = (pv?.product_variation_attributes ?? []) as any[]
              const variation = attrs.map((a: any) => a.variation_values?.value).filter(Boolean).join(' / ')
              return (
                <TableRow key={item.id}>
                  <TableCell>
                    <span className="font-medium text-text-primary">
                      {pv?.products?.name ?? '—'}
                    </span>
                    <span className="block text-xs text-text-muted font-mono">{pv?.sku_variation}</span>
                  </TableCell>
                  <TableCell muted>{variation || 'Padrão'}</TableCell>
                  <TableCell align="right">{item.quantity}</TableCell>
                  <TableCell align="right">{formatCurrency(item.unit_price)}</TableCell>
                  <TableCell align="right" className="font-semibold">{formatCurrency(item.total_price)}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>

      {/* Financial Summary */}
      <Card padding="md">
        <h3 className="text-sm font-semibold text-text-primary mb-4">Resumo Financeiro</h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-text-muted">Subtotal</span>
            <span className="text-text-secondary">{formatCurrency(sale.subtotal)}</span>
          </div>
          {sale.discount_amount > 0 && (
            <div className="flex justify-between">
              <span className="text-text-muted">Desconto</span>
              <span className="text-error">− {formatCurrency(sale.discount_amount)}</span>
            </div>
          )}
          {sale.shipping_charged > 0 && (
            <div className="flex justify-between">
              <span className="text-text-muted">Frete</span>
              <span className="text-text-secondary">+ {formatCurrency(sale.shipping_charged)}</span>
            </div>
          )}
          {(sale.surcharge_amount ?? 0) > 0 && (
            <div className="flex justify-between">
              <span className="text-text-muted">Acréscimo</span>
              <span className="text-warning">+ {formatCurrency(sale.surcharge_amount)}</span>
            </div>
          )}
          {sale.cashback_used > 0 && (
            <div className="flex justify-between">
              <span className="text-text-muted">Cashback Utilizado</span>
              <span className="text-success">− {formatCurrency(sale.cashback_used)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold pt-2 border-t border-border text-text-primary">
            <span>Total</span>
            <span>{formatCurrency(sale.total)}</span>
          </div>
        </div>
      </Card>

      {/* Pagamentos detalhados (sale_payments) */}
      {sale.salePayments && sale.salePayments.length > 0 ? (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Formas de Pagamento</h3>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Método</TableHead>
                <TableHead align="right">Valor cobrado</TableHead>
                <TableHead align="right">Entregue</TableHead>
                <TableHead align="right">Troco</TableHead>
                <TableHead align="right">Taxa</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sale.salePayments.map((p: any) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <span className="font-medium text-text-primary">
                      {PAYMENT_LABELS[p.method] ?? p.method}
                      {p.installments > 1 ? ` ${p.installments}×` : ''}
                    </span>
                    {p.card_brand && (
                      <span className="block text-xs text-text-muted">{p.card_brand}{p.acquirer ? ` · ${p.acquirer}` : ''}</span>
                    )}
                    {p.change_method && p.change_amount > 0 && (
                      <span className="block text-xs text-text-muted">
                        Troco via {p.change_method === 'pix' ? 'PIX' : 'dinheiro'}
                      </span>
                    )}
                  </TableCell>
                  <TableCell align="right" className="font-semibold">{formatCurrency(p.net_amount)}</TableCell>
                  <TableCell align="right" muted>{formatCurrency(p.amount_tendered)}</TableCell>
                  <TableCell align="right" muted>
                    {p.change_amount > 0 ? formatCurrency(p.change_amount) : '—'}
                  </TableCell>
                  <TableCell align="right" muted>
                    {p.fee_amount > 0 ? formatCurrency(p.fee_amount) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        /* Legado: exibe apenas o método registrado em sales.payment_method */
        <Card padding="md">
          <h3 className="text-sm font-semibold text-text-primary mb-2">Pagamento</h3>
          <p className="text-sm text-text-secondary">
            {PAYMENT_LABELS[sale.payment_method] ?? sale.payment_method}
          </p>
        </Card>
      )}

      {sale.notes && (
        <Card padding="md">
          <h3 className="text-sm font-semibold text-text-primary mb-2">Observações</h3>
          <p className="text-sm text-text-secondary">{sale.notes}</p>
        </Card>
      )}
    </div>
  )
}
