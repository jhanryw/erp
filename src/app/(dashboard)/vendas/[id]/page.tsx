import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
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

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pedido Realizado',
  paid: 'Pago',
  shipped: 'Enviado',
  delivered: 'Entregue',
  cancelled: 'Cancelado',
  returned: 'Devolvido',
}

const PAYMENT_LABELS: Record<string, string> = {
  pix: 'PIX', card: 'Cartão', cash: 'Dinheiro',
}

async function getSale(id: string) {
  const supabase = createClient()
  const { data } = await supabase
    .from('sales')
    .select(`
      *,
      customers (id, name, cpf, phone),
      users (name),
      sale_items (
        id, quantity, unit_price, total_price, unit_cost,
        product_variations (
          id, sku_variation, color, size, model, fabric,
          products (id, name, sku)
        )
      )
    `)
    .eq('id', Number(id))
    .single() as unknown as { data: any }
  return data
}

export default async function VendaDetalhePage({ params }: { params: { id: string } }) {
  const sale = await getSale(params.id)
  if (!sale) notFound()

  const isTerminal = sale.status === 'cancelled' || sale.status === 'returned'
  const canReturn = sale.status === 'delivered' || sale.status === 'paid'
  const currentStepIndex = STATUS_STEPS.indexOf(sale.status as SaleStatus)

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
                    {STATUS_LABELS[step]}
                  </span>
                </div>
              )
            })}
          </div>
        </Card>
      ) : (
        <Card padding="md">
          <p className="text-sm text-text-secondary">
            Este pedido foi <span className="font-semibold text-text-primary">{STATUS_LABELS[sale.status]}</span>.
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
              const variation = [pv?.color, pv?.size, pv?.model, pv?.fabric].filter(Boolean).join(' / ')
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
          {sale.cashback_used > 0 && (
            <div className="flex justify-between">
              <span className="text-text-muted">Cashback Utilizado</span>
              <span className="text-success">− {formatCurrency(sale.cashback_used)}</span>
            </div>
          )}
          {sale.shipping_charged > 0 && (
            <div className="flex justify-between">
              <span className="text-text-muted">Frete</span>
              <span className="text-text-secondary">{formatCurrency(sale.shipping_charged)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold pt-2 border-t border-border text-text-primary">
            <span>Total</span>
            <span>{formatCurrency(sale.total)}</span>
          </div>
        </div>
      </Card>

      {sale.notes && (
        <Card padding="md">
          <h3 className="text-sm font-semibold text-text-primary mb-2">Observações</h3>
          <p className="text-sm text-text-secondary">{sale.notes}</p>
        </Card>
      )}
    </div>
  )
}
