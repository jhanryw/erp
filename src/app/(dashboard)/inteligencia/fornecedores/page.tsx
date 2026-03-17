import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'

export const dynamic = 'force-dynamic'

async function getSupplierRankingData() {
  const supabase = createClient()
  const { data } = await supabase
    .from('mv_supplier_performance')
    .select('*')
    .order('total_revenue', { ascending: false }) as unknown as { data: any[] | null }
  return data ?? []
}

export default async function RankingFornecedoresPage() {
  const suppliers = await getSupplierRankingData()

  const totalRevenue = suppliers.reduce((s, sup) => s + (sup.total_revenue ?? 0), 0)
  const totalProfit = suppliers.reduce((s, sup) => s + (sup.total_gross_profit ?? 0), 0)
  const avgMargin = suppliers.length > 0
    ? suppliers.filter(s => (s.avg_margin_pct ?? 0) > 0).reduce((s, sup) => s + sup.avg_margin_pct, 0) / suppliers.filter(s => s.avg_margin_pct > 0).length
    : 0

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/inteligencia">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Ranking de Fornecedores</h2>
          <p className="text-sm text-text-muted">Compare margem, volume e faturamento por fornecedor</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Fornecedores', value: suppliers.length, sub: 'com vendas registradas' },
          { label: 'Faturamento Total', value: formatCurrency(totalRevenue) },
          { label: 'Lucro Bruto Total', value: formatCurrency(totalProfit) },
          { label: 'Margem Média', value: `${avgMargin.toFixed(1)}%`, className: avgMargin >= 30 ? 'text-success' : avgMargin >= 15 ? 'text-warning' : 'text-error' },
        ].map((kpi) => (
          <div key={kpi.label} className="card p-4">
            <p className="text-xs text-text-muted mb-1">{kpi.label}</p>
            <p className={`text-xl font-bold ${kpi.className ?? 'text-text-primary'}`}>{kpi.value}</p>
            {kpi.sub && <p className="text-xs text-text-muted mt-0.5">{kpi.sub}</p>}
          </div>
        ))}
      </div>

      {/* Participação no faturamento */}
      {suppliers.length > 0 && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Participação no Faturamento</h3>
          </CardHeader>
          <div className="p-5 space-y-3">
            {suppliers.slice(0, 8).map((sup) => {
              const pct = totalRevenue > 0 ? ((sup.total_revenue ?? 0) / totalRevenue) * 100 : 0
              return (
                <div key={sup.supplier_id}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-text-secondary font-medium">{sup.supplier_name}</span>
                    <span className="text-text-primary">{formatCurrency(sup.total_revenue ?? 0)} ({pct.toFixed(1)}%)</span>
                  </div>
                  <div className="h-1.5 bg-bg-overlay rounded-full">
                    <div className="h-full bg-brand rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">Ranking Completo</h3>
        </CardHeader>
        {suppliers.length === 0 ? (
          <div className="p-12 text-center text-sm text-text-muted">
            Nenhum fornecedor com vendas registradas. Cadastre entradas de estoque com fornecedor associado.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Fornecedor</TableHead>
                <TableHead align="right">Produtos</TableHead>
                <TableHead align="right">Unid. Vendidas</TableHead>
                <TableHead align="right">Faturamento</TableHead>
                <TableHead align="right">Lucro Bruto</TableHead>
                <TableHead align="right">Margem %</TableHead>
                <TableHead align="center">Perf.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {suppliers.map((sup, idx) => {
                const margin = sup.avg_margin_pct ?? 0
                return (
                  <TableRow key={sup.supplier_id}>
                    <TableCell muted>{idx + 1}</TableCell>
                    <TableCell>
                      <Link href={`/fornecedores/${sup.supplier_id}`} className="font-medium hover:text-accent">
                        {sup.supplier_name}
                      </Link>
                    </TableCell>
                    <TableCell align="right">{sup.product_count ?? 0}</TableCell>
                    <TableCell align="right">{sup.total_units_sold ?? 0}</TableCell>
                    <TableCell align="right" className="font-semibold">{formatCurrency(sup.total_revenue ?? 0)}</TableCell>
                    <TableCell align="right" className="text-success">{formatCurrency(sup.total_gross_profit ?? 0)}</TableCell>
                    <TableCell align="right">
                      <span className={`font-semibold ${margin >= 30 ? 'text-success' : margin >= 15 ? 'text-warning' : 'text-error'}`}>
                        {margin.toFixed(1)}%
                      </span>
                    </TableCell>
                    <TableCell align="center">
                      <Badge
                        variant={margin >= 30 ? 'success' : margin >= 15 ? 'warning' : 'error'}
                        size="sm"
                      >
                        {margin >= 30 ? 'Ótimo' : margin >= 15 ? 'Regular' : 'Baixo'}
                      </Badge>
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
