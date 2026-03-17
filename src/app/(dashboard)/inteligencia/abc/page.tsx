import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'

async function getAbcData() {
  const supabase = createClient()
  const { data } = await supabase
    .from('mv_abc_by_revenue')
    .select('product_id, total_revenue, revenue_pct, cumulative_pct, abc_class')
    .order('total_revenue', { ascending: false }) as unknown as { data: any[] | null }
  const abcData = data ?? []

  if (abcData.length === 0) return { items: [], totals: { A: 0, B: 0, C: 0 } }

  const productIds = abcData.map(r => r.product_id)
  const { data: products } = await supabase
    .from('mv_product_performance')
    .select('product_id, product_name, sku, total_units_sold')
    .in('product_id', productIds) as unknown as { data: any[] | null }

  const productMap = Object.fromEntries((products ?? []).map(p => [p.product_id, p]))

  const items = abcData.map(r => ({
    ...r,
    product_name: productMap[r.product_id]?.product_name ?? '—',
    sku: productMap[r.product_id]?.sku ?? '—',
    total_units_sold: productMap[r.product_id]?.total_units_sold ?? 0,
  }))

  const totals = {
    A: items.filter(i => i.abc_class === 'A').length,
    B: items.filter(i => i.abc_class === 'B').length,
    C: items.filter(i => i.abc_class === 'C').length,
  }

  return { items, totals }
}

const ABC_BADGE: Record<string, { variant: 'success' | 'warning' | 'error'; label: string }> = {
  A: { variant: 'success', label: 'A — Essencial' },
  B: { variant: 'warning', label: 'B — Secundário' },
  C: { variant: 'error', label: 'C — Baixo Giro' },
}

export default async function CurvaAbcPage() {
  const { items, totals } = await getAbcData()

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/inteligencia">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Curva ABC — Faturamento</h2>
          <p className="text-sm text-text-muted">Classifique produtos pelos 80/20 do faturamento</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Classe A', value: totals.A, desc: '≤ 80% faturamento', color: 'text-success' },
          { label: 'Classe B', value: totals.B, desc: '80–95% faturamento', color: 'text-warning' },
          { label: 'Classe C', value: totals.C, desc: '95–100% faturamento', color: 'text-error' },
        ].map((k) => (
          <div key={k.label} className="card p-4">
            <p className="text-xs text-text-muted mb-1">{k.label}</p>
            <p className={`text-2xl font-bold ${k.color}`}>{k.value} produtos</p>
            <p className="text-xs text-text-muted mt-1">{k.desc}</p>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">Ranking por Faturamento</h3>
        </CardHeader>
        {items.length === 0 ? (
          <div className="p-12 text-center text-sm text-text-muted">Sem dados de vendas. Registre vendas para ver a Curva ABC.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Produto</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead align="right">Faturamento</TableHead>
                <TableHead align="right">% do Total</TableHead>
                <TableHead align="right">% Acumulado</TableHead>
                <TableHead align="right">Qtd Vendida</TableHead>
                <TableHead align="center">Classe</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item, idx) => {
                const abc = ABC_BADGE[item.abc_class] ?? { variant: 'default' as const, label: item.abc_class }
                return (
                  <TableRow key={item.product_id}>
                    <TableCell muted>{idx + 1}</TableCell>
                    <TableCell>
                      <Link href={`/produtos/${item.product_id}`} className="font-medium hover:text-accent">
                        {item.product_name}
                      </Link>
                    </TableCell>
                    <TableCell muted><span className="font-mono text-xs">{item.sku}</span></TableCell>
                    <TableCell align="right" className="font-semibold">{formatCurrency(item.total_revenue)}</TableCell>
                    <TableCell align="right" muted>{item.revenue_pct?.toFixed(2)}%</TableCell>
                    <TableCell align="right">
                      <span className={`font-medium ${item.cumulative_pct <= 80 ? 'text-success' : item.cumulative_pct <= 95 ? 'text-warning' : 'text-error'}`}>
                        {item.cumulative_pct?.toFixed(1)}%
                      </span>
                    </TableCell>
                    <TableCell align="right">{item.total_units_sold}</TableCell>
                    <TableCell align="center">
                      <Badge variant={abc.variant} size="sm">{item.abc_class}</Badge>
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
