import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils/currency'

export const dynamic = 'force-dynamic'

async function getMarginData() {
  const supabase = createClient()
  const { data } = await supabase
    .from('mv_product_performance')
    .select('product_id, product_name, sku, base_cost, base_price, margin_pct, realized_margin_pct, total_revenue, total_gross_profit, total_units_sold')
    .gt('total_units_sold', 0)
    .order('realized_margin_pct', { ascending: false }) as unknown as { data: any[] | null }
  return data ?? []
}

export default async function MargemLucroPage() {
  const products = await getMarginData()

  const avgPlanned = products.length > 0
    ? products.reduce((s, p) => s + (p.margin_pct ?? 0), 0) / products.length
    : 0
  const avgRealized = products.length > 0
    ? products.reduce((s, p) => s + (p.realized_margin_pct ?? 0), 0) / products.length
    : 0
  const totalRevenue = products.reduce((s, p) => s + (p.total_revenue ?? 0), 0)
  const totalProfit = products.reduce((s, p) => s + (p.total_gross_profit ?? 0), 0)
  const overallMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/inteligencia">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Margem e Lucro</h2>
          <p className="text-sm text-text-muted">Compare margem planejada vs. margem realizada</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Margem Planejada Média', value: `${avgPlanned.toFixed(1)}%`, sub: 'baseada no custo base' },
          { label: 'Margem Realizada Média', value: `${avgRealized.toFixed(1)}%`, sub: 'sobre vendas reais', className: avgRealized >= avgPlanned ? 'text-success' : 'text-warning' },
          { label: 'Lucro Bruto Total', value: formatCurrency(totalProfit) },
          { label: 'Margem Geral Real.', value: `${overallMargin.toFixed(1)}%`, sub: 'sobre todo faturamento', className: overallMargin >= 30 ? 'text-success' : overallMargin >= 15 ? 'text-warning' : 'text-error' },
        ].map((kpi) => (
          <div key={kpi.label} className="card p-4">
            <p className="text-xs text-text-muted mb-1">{kpi.label}</p>
            <p className={`text-xl font-bold ${kpi.className ?? 'text-text-primary'}`}>{kpi.value}</p>
            {kpi.sub && <p className="text-xs text-text-muted mt-0.5">{kpi.sub}</p>}
          </div>
        ))}
      </div>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">Margem por Produto — Planejada vs. Realizada</h3>
        </CardHeader>
        {products.length === 0 ? (
          <div className="p-12 text-center text-sm text-text-muted">Nenhuma venda registrada ainda</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produto</TableHead>
                <TableHead align="right">Custo Base</TableHead>
                <TableHead align="right">Preço Base</TableHead>
                <TableHead align="right">Margem Plan.</TableHead>
                <TableHead align="right">Margem Real.</TableHead>
                <TableHead align="right">Δ Margem</TableHead>
                <TableHead align="right">Lucro Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => {
                const delta = (p.realized_margin_pct ?? 0) - (p.margin_pct ?? 0)
                return (
                  <TableRow key={p.product_id}>
                    <TableCell>
                      <Link href={`/produtos/${p.product_id}`} className="font-medium hover:text-accent">
                        {p.product_name}
                      </Link>
                      <span className="block font-mono text-xs text-text-muted">{p.sku}</span>
                    </TableCell>
                    <TableCell align="right" muted>{formatCurrency(p.base_cost ?? 0)}</TableCell>
                    <TableCell align="right" muted>{formatCurrency(p.base_price ?? 0)}</TableCell>
                    <TableCell align="right" muted>{(p.margin_pct ?? 0).toFixed(1)}%</TableCell>
                    <TableCell align="right">
                      <span className={`font-semibold ${(p.realized_margin_pct ?? 0) >= 30 ? 'text-success' : (p.realized_margin_pct ?? 0) >= 15 ? 'text-warning' : 'text-error'}`}>
                        {(p.realized_margin_pct ?? 0).toFixed(1)}%
                      </span>
                    </TableCell>
                    <TableCell align="right">
                      <span className={`text-sm font-medium ${delta >= 0 ? 'text-success' : 'text-error'}`}>
                        {delta >= 0 ? '+' : ''}{delta.toFixed(1)}pp
                      </span>
                    </TableCell>
                    <TableCell align="right" className="font-semibold text-success">
                      {formatCurrency(p.total_gross_profit ?? 0)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  )
}
