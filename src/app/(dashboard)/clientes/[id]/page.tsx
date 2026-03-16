import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Edit, ShoppingCart, Gift, Star, Palette } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { RfmBadge, SaleStatusBadge, Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import { formatCPF } from '@/lib/utils/cpf'
import type { RfmSegment, SaleStatus, CashbackTransactionType, CashbackStatus } from '@/types/database.types'

const ORIGIN_LABELS: Record<string, string> = {
  instagram: 'Instagram', referral: 'Indicação', paid_traffic: 'Tráfego Pago',
  website: 'Site', store: 'Loja', other: 'Outro',
}

const CASHBACK_TYPE_LABELS: Record<CashbackTransactionType, string> = {
  earn: 'Crédito', release: 'Liberação', use: 'Uso', expire: 'Expiração', reverse: 'Estorno',
}

const CASHBACK_STATUS_COLOR: Record<CashbackStatus, string> = {
  pending: 'text-warning',
  available: 'text-success',
  used: 'text-text-muted',
  expired: 'text-error',
  reversed: 'text-error',
}

async function getCustomer(id: string) {
  const supabase = createClient()
  const customerId = Number(id)

  const { data: customer } = await supabase
    .from('customers')
    .select('*, customer_metrics (*)')
    .eq('id', customerId)
    .single() as unknown as { data: any }

  if (!customer) return null

  const [
    { data: sales },
    { data: cashback },
    { data: cashbackTx },
  ] = await Promise.all([
    supabase
      .from('sales')
      .select('id, sale_number, total, status, sale_date, payment_method')
      .eq('customer_id', customerId)
      .order('sale_date', { ascending: false })
      .limit(10) as unknown as Promise<{ data: any[] }>,
    supabase
      .from('v_cashback_balance')
      .select('*')
      .eq('customer_id', customerId)
      .single() as unknown as Promise<{ data: any }>,
    supabase
      .from('cashback_transactions')
      .select('id, type, amount, status, release_date, expiry_date, used_at, created_at, sale_id')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(20) as unknown as Promise<{ data: any[] }>,
  ])

  // Compute preferences from sale items in recent purchases
  let favColor: string | null = null
  let favSize: string | null = null
  const saleIds = (sales ?? []).map((s: any) => s.id)

  if (saleIds.length > 0) {
    const { data: items } = await supabase
      .from('sale_items')
      .select('quantity, product_variations(color, size)')
      .in('sale_id', saleIds) as unknown as { data: any[] | null }

    const colorMap: Record<string, number> = {}
    const sizeMap: Record<string, number> = {}

    for (const item of items ?? []) {
      const pv = item.product_variations as any
      const qty = item.quantity ?? 1
      if (pv?.color) colorMap[pv.color] = (colorMap[pv.color] ?? 0) + qty
      if (pv?.size) sizeMap[pv.size] = (sizeMap[pv.size] ?? 0) + qty
    }

    favColor = Object.entries(colorMap).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    favSize = Object.entries(sizeMap).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }

  return {
    customer,
    sales: sales ?? [],
    cashback,
    cashbackTx: cashbackTx ?? [],
    preferences: { favColor, favSize },
  }
}

export default async function ClienteDetalhePage({ params }: { params: { id: string } }) {
  const result = await getCustomer(params.id)
  if (!result) notFound()

  const { customer, sales, cashback, cashbackTx, preferences } = result
  const metrics = (customer.customer_metrics as any)?.[0] ?? null

  return (
    <div className="space-y-5 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link href="/clientes">
            <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-text-primary">{customer.name}</h2>
              {metrics?.rfm_segment && <RfmBadge segment={metrics.rfm_segment as RfmSegment} />}
            </div>
            <div className="flex items-center gap-3 mt-0.5">
              <span className="text-sm text-text-muted">{formatCPF(customer.cpf)}</span>
              <span className="text-text-muted">·</span>
              <span className="text-sm text-text-muted">{customer.phone}</span>
              {customer.origin && (
                <>
                  <span className="text-text-muted">·</span>
                  <span className="text-sm text-text-muted">{ORIGIN_LABELS[customer.origin] ?? customer.origin}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <Link href={`/clientes/${customer.id}/editar`}>
          <Button variant="secondary" size="sm"><Edit className="w-3.5 h-3.5" />Editar</Button>
        </Link>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total Gasto" value={formatCurrency(metrics?.total_spent ?? 0)} icon={<ShoppingCart className="w-4 h-4" />} />
        <StatCard title="Compras" value={metrics?.order_count ?? 0} subtitle="pedidos" />
        <StatCard title="Ticket Médio" value={formatCurrency(metrics?.avg_ticket ?? 0)} />
        <StatCard
          title="Cashback Disponível"
          value={formatCurrency(cashback?.available_balance ?? 0)}
          subtitle={cashback?.pending_balance ? `+ ${formatCurrency(cashback.pending_balance)} a liberar` : undefined}
          icon={<Gift className="w-4 h-4" />}
          valueClassName="text-success"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Purchase history */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold text-text-primary">Histórico de Compras</h3>
            </CardHeader>
            {sales.length === 0 ? (
              <div className="p-8 text-center text-sm text-text-muted">Nenhuma compra registrada</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Pedido</TableHead>
                    <TableHead>Data</TableHead>
                    <TableHead align="right">Total</TableHead>
                    <TableHead align="center">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sales.map((sale) => (
                    <TableRow key={sale.id}>
                      <TableCell>
                        <Link href={`/vendas/${sale.id}`} className="font-mono text-xs text-accent hover:text-accent-muted">
                          {sale.sale_number}
                        </Link>
                      </TableCell>
                      <TableCell muted>{formatDate(sale.sale_date)}</TableCell>
                      <TableCell align="right" className="font-semibold">{formatCurrency(sale.total)}</TableCell>
                      <TableCell align="center">
                        <SaleStatusBadge status={sale.status as SaleStatus} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </div>

        {/* Right column: RFM + Preferences + Notes */}
        <div className="space-y-4">
          {metrics?.rfm_r_score && (
            <Card padding="md">
              <h3 className="text-sm font-semibold text-text-primary mb-4 flex items-center gap-2">
                <Star className="w-4 h-4 text-brand" /> Score RFM
              </h3>
              <div className="space-y-3">
                {(['R', 'F', 'M'] as const).map((key) => {
                  const score = metrics[`rfm_${key.toLowerCase()}_score` as keyof typeof metrics] as number
                  const labels = { R: 'Recência', F: 'Frequência', M: 'Valor' }
                  return (
                    <div key={key}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-text-muted">{labels[key]}</span>
                        <span className="font-semibold text-text-primary">{score}/5</span>
                      </div>
                      <div className="h-2 bg-bg-overlay rounded-full overflow-hidden">
                        <div
                          className="h-full bg-brand rounded-full"
                          style={{ width: `${(score / 5) * 100}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </Card>
          )}

          {/* Preferences */}
          {(preferences.favColor || preferences.favSize) && (
            <Card padding="md">
              <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
                <Palette className="w-4 h-4 text-brand" /> Preferências
              </h3>
              <div className="space-y-2">
                {preferences.favColor && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-muted">Cor favorita</span>
                    <span className="text-xs font-semibold text-text-primary">{preferences.favColor}</span>
                  </div>
                )}
                {preferences.favSize && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-muted">Tamanho favorito</span>
                    <span className="text-xs font-semibold text-text-primary">{preferences.favSize}</span>
                  </div>
                )}
              </div>
            </Card>
          )}

          {customer.notes && (
            <Card padding="md">
              <h3 className="text-sm font-semibold text-text-primary mb-2">Observações</h3>
              <p className="text-sm text-text-secondary">{customer.notes}</p>
            </Card>
          )}
        </div>
      </div>

      {/* Cashback Transactions */}
      {cashbackTx.length > 0 && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Histórico de Cashback</h3>
            <div className="flex items-center gap-4 text-xs">
              <span className="text-text-muted">
                Disponível: <span className="font-semibold text-success">{formatCurrency(cashback?.available_balance ?? 0)}</span>
              </span>
              {(cashback?.pending_balance ?? 0) > 0 && (
                <span className="text-text-muted">
                  A liberar: <span className="font-semibold text-warning">{formatCurrency(cashback.pending_balance)}</span>
                </span>
              )}
            </div>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tipo</TableHead>
                <TableHead>Data</TableHead>
                <TableHead align="right">Valor</TableHead>
                <TableHead align="center">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cashbackTx.map((tx: any) => (
                <TableRow key={tx.id}>
                  <TableCell>
                    <span className="font-medium">{CASHBACK_TYPE_LABELS[tx.type as CashbackTransactionType] ?? tx.type}</span>
                    {tx.sale_id && (
                      <Link href={`/vendas/${tx.sale_id}`} className="block text-xs text-accent hover:text-accent-muted">
                        Ver venda
                      </Link>
                    )}
                  </TableCell>
                  <TableCell muted>{formatDate(tx.created_at)}</TableCell>
                  <TableCell align="right" className="font-semibold tabular-nums">
                    {formatCurrency(tx.amount)}
                  </TableCell>
                  <TableCell align="center">
                    <span className={`text-xs font-medium ${CASHBACK_STATUS_COLOR[tx.status as CashbackStatus] ?? 'text-text-muted'}`}>
                      {tx.status}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}
