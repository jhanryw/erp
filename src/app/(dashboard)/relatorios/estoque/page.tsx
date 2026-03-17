import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

async function getStockData() {
  const supabase = createClient()
  const { data } = await supabase
    .from('mv_stock_status')
    .select('*')
    .order('current_qty', { ascending: false })
    .limit(200) as unknown as { data: any[] | null }
  return data ?? []
}

export default async function RelatorioEstoquePage() {
  const stock = await getStockData()

  const totalItems = stock.reduce((s, i) => s + (i.current_qty ?? 0), 0)
  const totalValueCost = stock.reduce((s, i) => s + (i.stock_value_at_cost ?? 0), 0)
  const totalValuePrice = stock.reduce((s, i) => s + (i.stock_value_at_price ?? 0), 0)
  const zeroStock = stock.filter(i => (i.current_qty ?? 0) === 0).length
  const lowStock = stock.filter(i => (i.current_qty ?? 0) > 0 && (i.current_qty ?? 0) <= 3).length

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/relatorios">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Relatório de Estoque</h2>
          <p className="text-sm text-text-muted">{stock.length} variações em estoque</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total de Peças', value: totalItems },
          { label: 'Valor a Custo', value: formatCurrency(totalValueCost) },
          { label: 'Valor a Preço', value: formatCurrency(totalValuePrice) },
          { label: 'Alertas', value: `${zeroStock} zerados / ${lowStock} baixos`, className: zeroStock > 0 ? 'text-error' : 'text-warning' },
        ].map((kpi) => (
          <div key={kpi.label} className="card p-4">
            <p className="text-xs text-text-muted mb-1">{kpi.label}</p>
            <p className={`text-xl font-bold ${kpi.className ?? 'text-text-primary'}`}>{kpi.value}</p>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">Posição de Estoque por Variação</h3>
        </CardHeader>
        {stock.length === 0 ? (
          <div className="p-12 text-center text-sm text-text-muted">Nenhum item em estoque</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produto</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead align="right">Qtd Atual</TableHead>
                <TableHead align="right">Custo Médio</TableHead>
                <TableHead align="right">Val. Custo</TableHead>
                <TableHead align="right">Val. Venda</TableHead>
                <TableHead>Última Entrada</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stock.map((item) => {
                const isZero = (item.current_qty ?? 0) === 0
                const isLow = !isZero && (item.current_qty ?? 0) <= 3
                return (
                  <TableRow key={item.product_variation_id}>
                    <TableCell>
                      <Link href={`/produtos/${item.product_id}`} className="font-medium hover:text-accent">
                        {item.product_name}
                      </Link>
                    </TableCell>
                    <TableCell muted><span className="font-mono text-xs">{item.sku}</span></TableCell>
                    <TableCell align="right">
                      <span className={`font-semibold ${isZero ? 'text-error' : isLow ? 'text-warning' : 'text-text-primary'}`}>
                        {item.current_qty ?? 0}
                      </span>
                    </TableCell>
                    <TableCell align="right" muted>{formatCurrency(item.avg_cost ?? 0)}</TableCell>
                    <TableCell align="right">{formatCurrency(item.stock_value_at_cost ?? 0)}</TableCell>
                    <TableCell align="right">{formatCurrency(item.stock_value_at_price ?? 0)}</TableCell>
                    <TableCell muted>
                      {item.last_entry_date ? formatDate(item.last_entry_date) : '—'}
                    </TableCell>
                    <TableCell>
                      {isZero ? (
                        <Badge variant="error" size="sm">Zerado</Badge>
                      ) : isLow ? (
                        <Badge variant="warning" size="sm">Baixo</Badge>
                      ) : (
                        <Badge variant="success" size="sm">Normal</Badge>
                      )}
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
