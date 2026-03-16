import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Edit, ShoppingCart, Gift, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { RfmBadge, SaleStatusBadge, Badge } from '@/components/ui/badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import { formatCPF } from '@/lib/utils/cpf'
import type { RfmSegment, SaleStatus } from '@/types/database.types'

const ORIGIN_LABELS: Record<string, string> = {
  instagram: 'Instagram', referral: 'Indicação', paid_traffic: 'Tráfego Pago',
  website: 'Site', store: 'Loja', other: 'Outro',
}

async function getCustomer(id: string) {
  const supabase = createClient()
  const [customer, sales, cashback] = await Promise.all([
    supabase
      .from('customers')
      .select(`*, customer_metrics (*)`)
      .eq('id', id)
      .single(),
    supabase
      .from('sales')
      .select('id, sale_number, total, status, sale_date, payment_method')
      .eq('customer_id', id)
      .order('sale_date', { ascending: false })
      .limit(10),
    supabase
      .from('v_cashback_balance')
      .select('*')
      .eq('customer_id', id)
      .single(),
  ])

  if (!customer.data) return null
  return { customer: customer.data, sales: sales.data ?? [], cashback: cashback.data }
}

export default async function ClienteDetalhePage({ params }: { params: { id: string } }) {
  const result = await getCustomer(params.id)
  if (!result) notFound()

  const { customer, sales, cashback } = result
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
        {/* Histórico de compras */}
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

        {/* RFM Score */}
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

          {customer.notes && (
            <Card padding="md">
              <h3 className="text-sm font-semibold text-text-primary mb-2">Observações</h3>
              <p className="text-sm text-text-secondary">{customer.notes}</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
