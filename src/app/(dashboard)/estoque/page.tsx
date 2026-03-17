import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { Plus, Warehouse, AlertTriangle, Package, DollarSign } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCurrency, formatNumber } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

async function getStockData() {
  const supabase = createClient()
  const [stockItems, summary] = await Promise.all([
    supabase
      .from('mv_stock_status')
      .select('*')
      .order('current_qty', { ascending: true })
      .limit(50) as unknown as Promise<{ data: any[] | null, error: any }>,
    supabase
      .from('mv_stock_status')
      .select('current_qty, stock_value_at_cost, stock_value_at_price') as unknown as Promise<{ data: any[] | null, error: any }>,
  ])

  const items = stockItems.data ?? []
  const all = summary.data ?? []

  return {
    items,
    totalQty: all.reduce((s, r) => s + (r.current_qty ?? 0), 0),
    totalCostValue: all.reduce((s, r) => s + (r.stock_value_at_cost ?? 0), 0),
    totalSaleValue: all.reduce((s, r) => s + (r.stock_value_at_price ?? 0), 0),
    alertCount: all.filter((r) => r.current_qty <= 3).length,
  }
}

export default async function EstoquePage() {
  const data = await getStockData()

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Estoque</h2>
          <p className="text-sm text-text-muted">Posição atual</p>
        </div>
        <Link href="/estoque/entrada">
          <Button size="sm">
            <Plus className="w-4 h-4" />
            Registrar Entrada
          </Button>
        </Link>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total em Estoque"
          value={formatNumber(data.totalQty)}
          subtitle="unidades"
          icon={<Package className="w-4 h-4" />}
        />
        <StatCard
          title="Valor a Custo"
          value={formatCurrency(data.totalCostValue)}
          subtitle="imobilizado"
          icon={<Warehouse className="w-4 h-4" />}
        />
        <StatCard
          title="Valor a Preço"
          value={formatCurrency(data.totalSaleValue)}
          subtitle="potencial de venda"
          icon={<DollarSign className="w-4 h-4" />}
        />
        <StatCard
          title="Alertas"
          value={data.alertCount}
          subtitle="produtos com estoque baixo"
          icon={<AlertTriangle className="w-4 h-4" />}
          valueClassName={data.alertCount > 0 ? 'text-warning' : undefined}
        />
      </div>

      {/* Links rápidos */}
      <div className="flex gap-3">
        <Link href="/estoque/movimentacoes">
          <Button variant="secondary" size="sm">Ver Movimentações</Button>
        </Link>
        <Link href="/estoque/alertas">
          <Button variant="secondary" size="sm">
            {data.alertCount > 0 && (
              <span className="w-2 h-2 rounded-full bg-warning mr-1" />
            )}
            Ver Alertas
          </Button>
        </Link>
      </div>

      {/* Tabela */}
      <Card>
        {data.items.length === 0 ? (
          <EmptyState
            icon={<Warehouse className="w-6 h-6 text-text-muted" />}
            title="Estoque vazio"
            description="Registre a primeira entrada de estoque."
          />
        ) : (
          <>
            <CardHeader>
              <p className="text-xs text-text-muted">{data.items.length} variações em estoque</p>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produto</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead align="right">Qtd</TableHead>
                  <TableHead align="right">Custo Médio</TableHead>
                  <TableHead align="right">Valor Custo</TableHead>
                  <TableHead align="right">Valor Venda</TableHead>
                  <TableHead>Última Entrada</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((item: any) => (
                  <TableRow key={item.product_variation_id}>
                    <TableCell>
                      <Link href={`/produtos/${item.product_id}`} className="text-sm font-medium hover:text-accent">
                        {item.product_name}
                      </Link>
                    </TableCell>
                    <TableCell muted>
                      <code className="text-xs bg-bg-overlay px-1.5 py-0.5 rounded">{item.sku}</code>
                    </TableCell>
                    <TableCell align="right">
                      <span
                        className={`text-sm font-semibold ${
                          item.current_qty === 0
                            ? 'text-error'
                            : item.current_qty <= 3
                            ? 'text-warning'
                            : 'text-success'
                        }`}
                      >
                        {item.current_qty}
                      </span>
                    </TableCell>
                    <TableCell align="right" muted>
                      {formatCurrency(item.avg_cost)}
                    </TableCell>
                    <TableCell align="right" muted>
                      {formatCurrency(item.stock_value_at_cost)}
                    </TableCell>
                    <TableCell align="right" className="font-medium">
                      {formatCurrency(item.stock_value_at_price)}
                    </TableCell>
                    <TableCell muted>
                      {item.last_entry_date ? formatDate(item.last_entry_date) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Card>
    </div>
  )
}
