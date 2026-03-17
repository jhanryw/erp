import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

const ORIGIN_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  referral: 'Indicação',
  paid_traffic: 'Tráfego Pago',
  website: 'Site',
  store: 'Loja Física',
  other: 'Outro',
}

async function getClientsData() {
  const supabase = createClient()
  const { data } = await supabase
    .from('customers')
    .select(`
      id, name, city, state, origin, created_at,
      customer_metrics(total_spent, order_count, avg_ticket, last_purchase_date)
    `)
    .order('created_at', { ascending: false })
    .limit(100) as unknown as { data: any[] | null }
  return data ?? []
}

export default async function RelatorioClientesPage() {
  const customers = await getClientsData()

  const totalSpent = customers.reduce((s, c) => s + (c.customer_metrics?.total_spent ?? 0), 0)
  const totalOrders = customers.reduce((s, c) => s + (c.customer_metrics?.order_count ?? 0), 0)
  const avgLTV = customers.length > 0 ? totalSpent / customers.length : 0

  const byOrigin = customers.reduce((acc: Record<string, number>, c) => {
    const o = c.origin ?? 'other'
    acc[o] = (acc[o] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/relatorios">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Relatório de Clientes</h2>
          <p className="text-sm text-text-muted">{customers.length} clientes cadastrados</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total de Clientes', value: customers.length },
          { label: 'Receita Total', value: formatCurrency(totalSpent) },
          { label: 'Total de Pedidos', value: totalOrders },
          { label: 'LTV Médio', value: formatCurrency(avgLTV) },
        ].map((kpi) => (
          <div key={kpi.label} className="card p-4">
            <p className="text-xs text-text-muted mb-1">{kpi.label}</p>
            <p className="text-xl font-bold text-text-primary">{kpi.value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Por origem */}
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Por Canal de Origem</h3>
          </CardHeader>
          <div className="p-5 space-y-3">
            {(Object.entries(byOrigin) as [string, number][]).sort(([, a], [, b]) => b - a).map(([origin, count]) => (
              <div key={origin} className="flex justify-between items-center text-sm">
                <span className="text-text-secondary">{ORIGIN_LABELS[origin] ?? origin}</span>
                <Badge variant="default" size="sm">{count}</Badge>
              </div>
            ))}
          </div>
        </Card>

        {/* Top clientes */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold text-text-primary">Top Clientes por Gasto</h3>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Cidade</TableHead>
                  <TableHead>Origem</TableHead>
                  <TableHead align="right">Pedidos</TableHead>
                  <TableHead align="right">Total Gasto</TableHead>
                  <TableHead>Últ. Compra</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers
                  .sort((a, b) => (b.customer_metrics?.total_spent ?? 0) - (a.customer_metrics?.total_spent ?? 0))
                  .map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <Link href={`/clientes/${c.id}`} className="font-medium hover:text-accent">
                          {c.name}
                        </Link>
                      </TableCell>
                      <TableCell muted>{c.city ?? '—'}</TableCell>
                      <TableCell>
                        <Badge variant="default" size="sm">{ORIGIN_LABELS[c.origin] ?? '—'}</Badge>
                      </TableCell>
                      <TableCell align="right">{c.customer_metrics?.order_count ?? 0}</TableCell>
                      <TableCell align="right" className="font-semibold">{formatCurrency(c.customer_metrics?.total_spent ?? 0)}</TableCell>
                      <TableCell muted>
                        {c.customer_metrics?.last_purchase_date ? formatDate(c.customer_metrics.last_purchase_date) : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      </div>
    </div>
  )
}
