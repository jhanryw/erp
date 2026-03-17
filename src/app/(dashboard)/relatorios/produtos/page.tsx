import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils/currency'

export const dynamic = 'force-dynamic'

async function getProductsData() {
  const supabase = createClient()
  const { data } = await supabase
    .from('mv_product_performance')
    .select('product_id, product_name, sku, total_units_sold, total_revenue, total_gross_profit, realized_margin_pct, base_price, base_cost, margin_pct')
    .order('total_revenue', { ascending: false })
    .limit(100) as unknown as { data: any[] | null }
  return data ?? []
}

export default async function RelatorioProdutosPage() {
  const products = await getProductsData()

  const totalRevenue = products.reduce((s, p) => s + (p.total_revenue ?? 0), 0)
  const totalProfit = products.reduce((s, p) => s + (p.total_gross_profit ?? 0), 0)
  const totalUnits = products.reduce((s, p) => s + (p.total_units_sold ?? 0), 0)
  const avgMargin = products.length > 0
    ? products.filter(p => p.realized_margin_pct > 0).reduce((s, p) => s + p.realized_margin_pct, 0) / products.filter(p => p.realized_margin_pct > 0).length
    : 0

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/relatorios">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Relatório de Produtos</h2>
          <p className="text-sm text-text-muted">Performance de {products.length} produtos</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Faturamento Total', value: formatCurrency(totalRevenue) },
          { label: 'Lucro Bruto', value: formatCurrency(totalProfit) },
          { label: 'Unidades Vendidas', value: totalUnits },
          { label: 'Margem Média', value: `${avgMargin.toFixed(1)}%` },
        ].map((kpi) => (
          <div key={kpi.label} className="card p-4">
            <p className="text-xs text-text-muted mb-1">{kpi.label}</p>
            <p className="text-xl font-bold text-text-primary">{kpi.value}</p>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">Performance por Produto</h3>
        </CardHeader>
        {products.length === 0 ? (
          <div className="p-12 text-center text-sm text-text-muted">Nenhuma venda registrada ainda</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produto</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead align="right">Qtd Vendida</TableHead>
                <TableHead align="right">Faturamento</TableHead>
                <TableHead align="right">Lucro Bruto</TableHead>
                <TableHead align="right">Margem Plan.</TableHead>
                <TableHead align="right">Margem Real.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.product_id}>
                  <TableCell>
                    <Link href={`/produtos/${p.product_id}`} className="font-medium hover:text-accent">
                      {p.product_name}
                    </Link>
                  </TableCell>
                  <TableCell muted><span className="font-mono text-xs">{p.sku}</span></TableCell>
                  <TableCell align="right">{p.total_units_sold ?? 0}</TableCell>
                  <TableCell align="right" className="font-semibold">{formatCurrency(p.total_revenue ?? 0)}</TableCell>
                  <TableCell align="right" className="text-success">{formatCurrency(p.total_gross_profit ?? 0)}</TableCell>
                  <TableCell align="right" muted>{(p.margin_pct ?? 0).toFixed(1)}%</TableCell>
                  <TableCell align="right">
                    <span className={`font-semibold text-sm ${(p.realized_margin_pct ?? 0) >= 30 ? 'text-success' : (p.realized_margin_pct ?? 0) >= 15 ? 'text-warning' : 'text-error'}`}>
                      {(p.realized_margin_pct ?? 0).toFixed(1)}%
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  )
}
