import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils/currency'

export const dynamic = 'force-dynamic'

async function getColorData() {
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('mv_color_performance')
    .select('*')
    .order('total_revenue', { ascending: false }) as unknown as { data: any[] | null }
  return data ?? []
}

export default async function PerformanceCoresPage() {
  const colors = await getColorData()

  const totalRevenue = colors.reduce((s, c) => s + (c.total_revenue ?? 0), 0)
  const totalUnits = colors.reduce((s, c) => s + (c.total_units_sold ?? 0), 0)
  const topColor = colors[0]

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/inteligencia">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Performance por Cor</h2>
          <p className="text-sm text-text-muted">Faturamento e volume de vendas por cor</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Cores Analisadas', value: colors.length },
          { label: 'Unidades Vendidas', value: totalUnits },
          { label: 'Faturamento Total', value: formatCurrency(totalRevenue) },
          { label: 'Cor Mais Vendida', value: topColor?.color_name ?? '—', sub: topColor ? `${formatCurrency(topColor.total_revenue)} em receita` : '' },
        ].map((kpi) => (
          <div key={kpi.label} className="card p-4">
            <p className="text-xs text-text-muted mb-1">{kpi.label}</p>
            <p className="text-xl font-bold text-text-primary">{kpi.value}</p>
            {kpi.sub && <p className="text-xs text-text-muted mt-0.5">{kpi.sub}</p>}
          </div>
        ))}
      </div>

      {/* Barras de participação */}
      {colors.length > 0 && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Participação no Faturamento</h3>
          </CardHeader>
          <div className="p-5 space-y-3">
            {colors.slice(0, 10).map((c) => {
              const pct = totalRevenue > 0 ? (c.total_revenue / totalRevenue) * 100 : 0
              return (
                <div key={c.color_name}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-text-secondary font-medium">{c.color_name}</span>
                    <span className="text-text-primary font-semibold">{formatCurrency(c.total_revenue)} ({pct.toFixed(1)}%)</span>
                  </div>
                  <div className="h-2 bg-bg-overlay rounded-full">
                    <div className="h-full bg-brand rounded-full transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Tabela completa */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">Ranking Completo por Cor</h3>
        </CardHeader>
        {colors.length === 0 ? (
          <div className="p-12 text-center text-sm text-text-muted">
            Sem dados de performance por cor. Certifique-se de que as variações de produto têm o atributo &ldquo;Cor&rdquo; configurado.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Cor</TableHead>
                <TableHead align="right">Unid. Vendidas</TableHead>
                <TableHead align="right">Itens</TableHead>
                <TableHead align="right">Faturamento</TableHead>
                <TableHead align="right">Lucro Bruto</TableHead>
                <TableHead align="right">Preço Médio</TableHead>
                <TableHead align="right">% Faturamento</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {colors.map((c, idx) => {
                const pct = totalRevenue > 0 ? (c.total_revenue / totalRevenue) * 100 : 0
                return (
                  <TableRow key={c.color_name}>
                    <TableCell muted>{idx + 1}</TableCell>
                    <TableCell className="font-medium">{c.color_name}</TableCell>
                    <TableCell align="right">{c.total_units_sold ?? 0}</TableCell>
                    <TableCell align="right" muted>{c.total_items_sold ?? 0}</TableCell>
                    <TableCell align="right" className="font-semibold">{formatCurrency(c.total_revenue ?? 0)}</TableCell>
                    <TableCell align="right" className="text-success">{formatCurrency(c.total_gross_profit ?? 0)}</TableCell>
                    <TableCell align="right" muted>{formatCurrency(c.avg_price ?? 0)}</TableCell>
                    <TableCell align="right">
                      <span className="text-sm font-medium text-brand">{pct.toFixed(1)}%</span>
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
