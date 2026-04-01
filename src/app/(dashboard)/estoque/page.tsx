import Link from 'next/link'
import {
  Plus,
  Warehouse,
  AlertTriangle,
  Package,
  DollarSign,
} from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader } from '@/components/ui/card'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCurrency, formatNumber } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

export const dynamic = 'force-dynamic'

type StockStatusRow = {
  product_name: string
  sku: string
  current_qty: number | null
  avg_cost: number | null
  stock_value_at_cost: number | null
  stock_value_at_price: number | null
  last_entry_date: string | null
}

async function getStockData() {
  const supabase = createAdminClient()

  const [stockItems, summary] = await Promise.all([
    supabase
      .from('mv_stock_status')
      .select('*')
      .order('current_qty', { ascending: true })
      .limit(50),
    supabase
      .from('mv_stock_status')
      .select('current_qty, stock_value_at_cost, stock_value_at_price'),
  ])

  if (stockItems.error) {
    console.error('Erro ao listar estoque:', stockItems.error.message)
  }

  if (summary.error) {
    console.error('Erro ao resumir estoque:', summary.error.message)
  }

  const items = (stockItems.data ?? []) as StockStatusRow[]
  const all = (summary.data ?? []) as StockStatusRow[]

  return {
    items,
    totalQty: all.reduce((s, r) => s + Number(r.current_qty ?? 0), 0),
    totalCostValue: all.reduce(
      (s, r) => s + Number(r.stock_value_at_cost ?? 0),
      0
    ),
    totalSaleValue: all.reduce(
      (s, r) => s + Number(r.stock_value_at_price ?? 0),
      0
    ),
    alertCount: all.filter((r) => Number(r.current_qty ?? 0) <= 3).length,
  }
}

export default async function EstoquePage() {
  const data = await getStockData()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Estoque</h1>
          <p className="text-sm text-muted-foreground">Posição atual</p>
        </div>

        <div className="flex gap-2">
          <Link href="/estoque/entrada/matriz">
            <Button variant="outline">
              <Plus className="mr-2 h-4 w-4" />
              Entrada em Matriz
            </Button>
          </Link>
          <Link href="/estoque/entrada">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Registrar Entrada
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Quantidade Total"
          value={formatNumber(data.totalQty)}
          icon={<Warehouse className="h-4 w-4" />}
        />
        <StatCard
          title="Valor em Custo"
          value={formatCurrency(data.totalCostValue)}
          icon={<DollarSign className="h-4 w-4" />}
        />
        <StatCard
          title="Valor em Venda"
          value={formatCurrency(data.totalSaleValue)}
          icon={<Package className="h-4 w-4" />}
        />
        <StatCard
          title="Alertas de Estoque"
          value={formatNumber(data.alertCount)}
          icon={<AlertTriangle className="h-4 w-4" />}
          valueClassName={data.alertCount > 0 ? 'text-warning' : undefined}
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <Link href="/estoque/movimentacoes">
          <Button variant="outline">Ver Movimentações</Button>
        </Link>

        <Link href="/estoque/ajuste">
          <Button variant="outline">Ajuste de Estoque</Button>
        </Link>

        <Link href="/estoque/alertas">
          <Button variant="outline">
            Ver Alertas
            {data.alertCount > 0 && (
              <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning">
                {data.alertCount}
              </span>
            )}
          </Button>
        </Link>
      </div>

      {data.items.length === 0 ? (
        <EmptyState
          icon={<Warehouse className="h-4 w-4" />}
          title="Estoque vazio"
          description="Registre a primeira entrada de estoque."
          action={{ label: 'Registrar entrada', href: '/estoque/entrada' }}
/>
      ) : (
        <Card>
          <CardHeader className="text-sm text-muted-foreground">
            {data.items.length} variações em estoque
          </CardHeader>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produto</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Qtd</TableHead>
                  <TableHead>Custo Médio</TableHead>
                  <TableHead>Valor Custo</TableHead>
                  <TableHead>Valor Venda</TableHead>
                  <TableHead>Última Entrada</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {data.items.map((item, idx) => (
                  <TableRow key={`${item.sku}-${idx}`}>
                    <TableCell className="font-medium">
                      {item.product_name}
                    </TableCell>
                    <TableCell>
                      <code>{item.sku}</code>
                    </TableCell>
                    <TableCell>{formatNumber(item.current_qty ?? 0)}</TableCell>
                    <TableCell>{formatCurrency(item.avg_cost ?? 0)}</TableCell>
                    <TableCell>
                      {formatCurrency(item.stock_value_at_cost ?? 0)}
                    </TableCell>
                    <TableCell>
                      {formatCurrency(item.stock_value_at_price ?? 0)}
                    </TableCell>
                    <TableCell>
                      {item.last_entry_date
                        ? formatDate(item.last_entry_date)
                        : '—'}
                    </TableCell>
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