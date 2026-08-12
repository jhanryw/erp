import { createAdminClient } from '@/lib/supabase/admin'
import { requirePageRole } from '@/lib/auth/requirePageRole'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'

export const dynamic = 'force-dynamic'

async function getSupplierRankingData() {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('mv_supplier_performance' as any)
    .select('supplier_id, supplier_name, supplier_state, total_lots, total_purchased_value, total_units_sold, total_revenue, total_gross_profit, avg_margin_pct, product_count, avg_real_cost_per_unit, avg_freight_pct')
    .order('total_revenue', { ascending: false }) as unknown as { data: any[] | null; error: any }

  if (error) console.error('mv_supplier_performance error:', error.message)
  return data ?? []
}

export default async function RankingFornecedoresPage() {
  await requirePageRole('gerente')
  const suppliers = await getSupplierRankingData()

  const totalRevenue = suppliers.reduce((s, sup) => s + (sup.total_revenue ?? 0), 0)
  const totalProfit = suppliers.reduce((s, sup) => s + (sup.total_gross_profit ?? 0), 0)
  const withMargin = suppliers.filter(s => (s.avg_margin_pct ?? 0) > 0)
  const avgMargin = withMargin.length > 0
    ? withMargin.reduce((s, sup) => s + sup.avg_margin_pct, 0) / withMargin.length
    : 0

  // Resumo por UF
  const byUF = suppliers.reduce<Record<string, { totalPurchased: number; count: number }>>((acc, sup) => {
    const uf = sup.supplier_state ?? 'N/A'
    if (!acc[uf]) acc[uf] = { totalPurchased: 0, count: 0 }
    acc[uf].totalPurchased += sup.total_purchased_value ?? 0
    acc[uf].count++
    return acc
  }, {})
  const ufEntries = Object.entries(byUF).sort((a, b) => b[1].totalPurchased - a[1].totalPurchased)
  const totalPurchasedAll = suppliers.reduce((s, sup) => s + (sup.total_purchased_value ?? 0), 0)

  // Rankings de custo e frete
  const byRealCost = [...suppliers]
    .filter(s => (s.avg_real_cost_per_unit ?? 0) > 0)
    .sort((a, b) => (b.avg_real_cost_per_unit ?? 0) - (a.avg_real_cost_per_unit ?? 0))

  const byFreightImpact = [...suppliers]
    .filter(s => (s.avg_freight_pct ?? 0) > 0)
    .sort((a, b) => (b.avg_freight_pct ?? 0) - (a.avg_freight_pct ?? 0))

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

      {/* Resumo por UF */}
      {ufEntries.length > 0 && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Compras por Estado (UF)</h3>
          </CardHeader>
          <div className="p-5 space-y-3">
            {ufEntries.map(([uf, { totalPurchased, count }]) => {
              const pct = totalPurchasedAll > 0 ? (totalPurchased / totalPurchasedAll) * 100 : 0
              return (
                <div key={uf}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-text-secondary font-medium">
                      {uf} <span className="text-text-muted font-normal">({count} fornecedor{count !== 1 ? 'es' : ''})</span>
                    </span>
                    <span className="text-text-primary">{formatCurrency(totalPurchased)} ({pct.toFixed(1)}%)</span>
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

      {/* Ranking por custo real por unidade */}
      {byRealCost.length > 0 && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Ranking por Custo Real / Unidade</h3>
          </CardHeader>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Fornecedor</TableHead>
                  <TableHead>UF</TableHead>
                  <TableHead align="right">Custo Real/Un</TableHead>
                  <TableHead align="right">Frete %</TableHead>
                  <TableHead align="right">Produtos</TableHead>
                  <TableHead align="right">Total Comprado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byRealCost.map((sup, idx) => (
                  <TableRow key={sup.supplier_id}>
                    <TableCell muted>{idx + 1}</TableCell>
                    <TableCell>
                      <Link href={`/fornecedores/${sup.supplier_id}`} className="font-medium hover:text-accent">
                        {sup.supplier_name}
                      </Link>
                    </TableCell>
                    <TableCell muted>{sup.supplier_state ?? '—'}</TableCell>
                    <TableCell align="right" className="font-semibold">{formatCurrency(sup.avg_real_cost_per_unit ?? 0)}</TableCell>
                    <TableCell align="right">
                      <span className={(sup.avg_freight_pct ?? 0) > 10 ? 'text-warning font-medium' : 'text-text-secondary'}>
                        {(sup.avg_freight_pct ?? 0).toFixed(1)}%
                      </span>
                    </TableCell>
                    <TableCell align="right">{sup.product_count ?? 0}</TableCell>
                    <TableCell align="right">{formatCurrency(sup.total_purchased_value ?? 0)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      {/* Ranking por impacto de frete */}
      {byFreightImpact.length > 0 && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Ranking por Impacto de Frete</h3>
          </CardHeader>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Fornecedor</TableHead>
                  <TableHead>UF</TableHead>
                  <TableHead align="right">Frete %</TableHead>
                  <TableHead align="right">Custo Real/Un</TableHead>
                  <TableHead align="right">Total Comprado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byFreightImpact.map((sup, idx) => (
                  <TableRow key={sup.supplier_id}>
                    <TableCell muted>{idx + 1}</TableCell>
                    <TableCell>
                      <Link href={`/fornecedores/${sup.supplier_id}`} className="font-medium hover:text-accent">
                        {sup.supplier_name}
                      </Link>
                    </TableCell>
                    <TableCell muted>{sup.supplier_state ?? '—'}</TableCell>
                    <TableCell align="right">
                      <span className={(sup.avg_freight_pct ?? 0) > 10 ? 'text-warning font-medium' : (sup.avg_freight_pct ?? 0) > 5 ? 'text-text-primary' : 'text-text-secondary'}>
                        {(sup.avg_freight_pct ?? 0).toFixed(1)}%
                      </span>
                    </TableCell>
                    <TableCell align="right">{formatCurrency(sup.avg_real_cost_per_unit ?? 0)}</TableCell>
                    <TableCell align="right">{formatCurrency(sup.total_purchased_value ?? 0)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  )
}
