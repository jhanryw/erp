import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { SaleStatusBadge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import type { SaleStatus } from '@/types/database.types'

export const dynamic = 'force-dynamic'

async function getSalesData() {
  const supabase = createClient()
  const [salesRes, summaryRes] = await Promise.all([
    supabase
      .from('sales')
      .select('id, sale_number, total, discount_amount, payment_method, status, sale_date, customers(name)')
      .order('sale_date', { ascending: false })
      .limit(100) as unknown as Promise<{ data: any[] | null }>,
    supabase
      .from('mv_daily_sales_summary')
      .select('*')
      .order('sale_date', { ascending: false })
      .limit(30) as unknown as Promise<{ data: any[] | null }>,
  ])
  return {
    sales: salesRes.data ?? [],
    summary: summaryRes.data ?? [],
  }
}

const PAYMENT_LABELS: Record<string, string> = { pix: 'PIX', card: 'Cartão', cash: 'Dinheiro' }

export default async function RelatorioVendasPage() {
  const { sales, summary } = await getSalesData()

  const totalRevenue = sales.filter(s => !['cancelled', 'returned'].includes(s.status)).reduce((sum, s) => sum + s.total, 0)
  const avgTicket = sales.length > 0 ? totalRevenue / sales.filter(s => !['cancelled', 'returned'].includes(s.status)).length : 0
  const totalDiscount = sales.reduce((sum, s) => sum + (s.discount_amount ?? 0), 0)
  const cancelledCount = sales.filter(s => s.status === 'cancelled').length

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/relatorios">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Relatório de Vendas</h2>
          <p className="text-sm text-text-muted">Últimas {sales.length} vendas</p>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Faturamento Total', value: formatCurrency(totalRevenue), sub: 'vendas concluídas' },
          { label: 'Ticket Médio', value: formatCurrency(avgTicket), sub: 'por venda' },
          { label: 'Total Descontos', value: formatCurrency(totalDiscount), sub: 'descontos aplicados' },
          { label: 'Cancelamentos', value: cancelledCount, sub: `de ${sales.length} pedidos` },
        ].map((kpi) => (
          <div key={kpi.label} className="card p-4">
            <p className="text-xs text-text-muted mb-1">{kpi.label}</p>
            <p className="text-xl font-bold text-text-primary">{kpi.value}</p>
            <p className="text-xs text-text-muted mt-0.5">{kpi.sub}</p>
          </div>
        ))}
      </div>

      {/* Resumo Diário */}
      {summary.length > 0 && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Resumo por Dia (últimos 30 dias)</h3>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead align="right">Pedidos</TableHead>
                <TableHead align="right">Clientes Únicos</TableHead>
                <TableHead align="right">Faturamento</TableHead>
                <TableHead align="right">Ticket Médio</TableHead>
                <TableHead align="right">Descontos</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.map((day) => (
                <TableRow key={day.sale_date}>
                  <TableCell className="font-medium">{formatDate(day.sale_date)}</TableCell>
                  <TableCell align="right">{day.total_orders}</TableCell>
                  <TableCell align="right">{day.unique_customers}</TableCell>
                  <TableCell align="right" className="font-semibold">{formatCurrency(day.gross_revenue)}</TableCell>
                  <TableCell align="right">{formatCurrency(day.avg_ticket)}</TableCell>
                  <TableCell align="right" muted>{formatCurrency(day.total_discounts)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Vendas Detalhadas */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">Todas as Vendas</h3>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pedido</TableHead>
              <TableHead>Cliente</TableHead>
              <TableHead>Data</TableHead>
              <TableHead align="center">Pagamento</TableHead>
              <TableHead align="center">Status</TableHead>
              <TableHead align="right">Total</TableHead>
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
                <TableCell>{(sale.customers as any)?.name ?? '—'}</TableCell>
                <TableCell muted>{formatDate(sale.sale_date)}</TableCell>
                <TableCell align="center" muted>
                  <span className="text-xs">{PAYMENT_LABELS[sale.payment_method] ?? '—'}</span>
                </TableCell>
                <TableCell align="center">
                  <SaleStatusBadge status={sale.status as SaleStatus} />
                </TableCell>
                <TableCell align="right" className="font-semibold">{formatCurrency(sale.total)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
