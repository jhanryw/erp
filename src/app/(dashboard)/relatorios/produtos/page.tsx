import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils/currency'
import { requirePageRole } from '@/lib/auth/requirePageRole'
import { getProductModalityBreakdown } from '@/services/analytics/productModalityReport'
import { resolveDateRange } from '@/lib/utils/dateRange'

export const dynamic = 'force-dynamic'

// Analytics Varejo/Atacado — achado da auditoria curta desta fase:
// `getProductsData` nunca filtrava por `company_id` (mv_product_performance
// tem a coluna desde 20260812_add_company_id_dashboard_mvs.sql, mas esta
// página nunca a usava) — misturava produtos de TODAS as empresas no
// mesmo relatório. Corrigido aqui: `requirePageRole` já devolve o
// `profile` com `company_id`, só nunca era aproveitado.
async function getProductsData(companyId: number) {
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('mv_product_performance')
    .select('product_id, product_name, sku, total_units_sold, total_revenue, total_gross_profit, realized_margin_pct, base_price, base_cost, margin_pct')
    .eq('company_id', companyId)
    .order('total_revenue', { ascending: false })
    .limit(100) as unknown as { data: any[] | null }
  return data ?? []
}

type SearchParams = Promise<{ range?: string; from?: string; to?: string; modality?: string }>

export default async function RelatorioProdutosPage({ searchParams }: { searchParams: SearchParams }) {
  const profile = await requirePageRole('gerente')
  if (!profile.company_id) return <p className="text-sm text-text-muted p-6">Sem empresa vinculada.</p>

  const { range, from, to, modality } = await searchParams
  const { dateFrom, dateTo, rangeLabel } = resolveDateRange(range, from, to)
  const activeModality = modality === 'retail' || modality === 'wholesale' ? modality : undefined

  const [products, modalityRows] = await Promise.all([
    getProductsData(profile.company_id),
    getProductModalityBreakdown(profile.company_id, dateFrom, dateTo, activeModality),
  ])

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

      {/* ── Analytics Varejo/Atacado — produto por modalidade ────────────
          Diferente da tabela acima (mv_product_performance, acumulado
          histórico total): esta seção usa preço/custo REALIZADOS no
          período filtrado, quebrados por sale_type. */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Produto por Modalidade</h3>
              <p className="text-xs text-text-muted">{rangeLabel} · preço realizado da venda</p>
            </div>
            <form method="GET" className="flex items-center gap-2">
              <select
                name="modality"
                defaultValue={activeModality ?? ''}
                className="text-sm rounded-lg border border-border bg-bg-surface px-2 py-1.5 text-text-primary"
              >
                <option value="">Todos</option>
                <option value="retail">Varejo</option>
                <option value="wholesale">Atacado</option>
              </select>
              <button type="submit" className="text-sm rounded-lg bg-brand px-3 py-1.5 font-medium text-white hover:bg-brand/90 transition-colors">
                Filtrar
              </button>
            </form>
          </div>
        </CardHeader>
        {modalityRows.length === 0 ? (
          <div className="p-12 text-center text-sm text-text-muted">Nenhuma venda no período/modalidade selecionados.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produto</TableHead>
                <TableHead align="right">Unidades</TableHead>
                <TableHead align="right">Receita</TableHead>
                <TableHead align="right">CMV</TableHead>
                <TableHead align="right">Lucro Bruto</TableHead>
                <TableHead align="right">Margem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {modalityRows.slice(0, 50).map((p) => (
                <TableRow key={p.product_id}>
                  <TableCell>
                    <Link href={`/produtos/${p.product_id}`} className="font-medium hover:text-accent">
                      {p.product_name}
                    </Link>
                  </TableCell>
                  <TableCell align="right">{p.unitsSold}</TableCell>
                  <TableCell align="right" className="font-semibold">{formatCurrency(p.revenue)}</TableCell>
                  <TableCell align="right" muted>{formatCurrency(p.cmv)}</TableCell>
                  <TableCell align="right" className="text-success">{formatCurrency(p.grossProfit)}</TableCell>
                  <TableCell align="right">{p.marginPct != null ? `${p.marginPct.toFixed(1)}%` : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  )
}
