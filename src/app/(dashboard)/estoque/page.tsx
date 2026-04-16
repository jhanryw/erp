import { Suspense } from 'react'
import Link from 'next/link'
import {
  Plus,
  Warehouse,
  AlertTriangle,
  Package,
  DollarSign,
  Boxes,
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
import { EstoqueSearch } from './estoque-search'

export const dynamic = 'force-dynamic'

type StockStatusRow = {
  product_id: number
  product_name: string
  sku_variation: string
  tamanho: string | null
  cor: string | null
  current_qty: number | null
  avg_cost: number | null
  stock_value_at_cost: number | null
  stock_value_at_price: number | null
  last_entry_date: string | null
}

async function getStockData(search?: string) {
  const supabase = createAdminClient()

  let itemsQuery = supabase
    .from('mv_stock_status')
    .select('*')
    .order('product_name', { ascending: true })
    .order('current_qty', { ascending: true })

  if (search) {
    itemsQuery = itemsQuery.ilike('product_name', `%${search}%`)
  }

  const [stockItems, summary] = await Promise.all([
    itemsQuery,
    // Agrega todos os registros; product_id necessário para contagem de produtos distintos
    supabase
      .from('mv_stock_status')
      .select('product_id, current_qty, stock_value_at_cost, stock_value_at_price'),
  ])

  if (stockItems.error) {
    console.error('Erro ao listar estoque:', stockItems.error.message)
  }

  if (summary.error) {
    console.error('Erro ao resumir estoque:', summary.error.message)
  }

  const items = (stockItems.data ?? []) as StockStatusRow[]
  const all   = (summary.data ?? []) as StockStatusRow[]

  // Apenas variações com estoque físico real — variações zeradas continuam no catálogo
  // mas não devem distorcer os indicadores operacionais
  const withStock = all.filter((r) => Number(r.current_qty ?? 0) > 0)

  return {
    items,
    // Produtos distintos que possuem pelo menos uma variação em estoque
    productCount:   new Set(withStock.map((r) => r.product_id)).size,
    totalQty:       withStock.reduce((s, r) => s + Number(r.current_qty), 0),
    totalCostValue: withStock.reduce((s, r) => s + Number(r.stock_value_at_cost  ?? 0), 0),
    totalSaleValue: withStock.reduce((s, r) => s + Number(r.stock_value_at_price ?? 0), 0),
    // Alerta somente para variações que EXISTEM em estoque mas estão acabando (1–3 unidades)
    // Variações zeradas são placeholder de catálogo, não "alerta de falta"
    alertCount: withStock.filter((r) => Number(r.current_qty) <= 3).length,
  }
}

export default async function EstoquePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { q } = await searchParams
  const search = q?.trim() || undefined
  const data = await getStockData(search)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Estoque</h1>
          <p className="text-sm text-muted-foreground">Posição atual</p>
        </div>

        <div className="flex gap-2">
          <Link href="/estoque/entrada/lote">
            <Button variant="outline">
              <Plus className="mr-2 h-4 w-4" />
              Entrada em Lote
            </Button>
          </Link>
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

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          title="Produtos"
          value={formatNumber(data.productCount)}
          icon={<Boxes className="h-4 w-4" />}
        />
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

      <Suspense>
        <EstoqueSearch defaultValue={q} />
      </Suspense>

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
            {search
              ? `${data.items.length} variação${data.items.length !== 1 ? 'ões' : ''} encontrada${data.items.length !== 1 ? 's' : ''} para "${search}"`
              : `${data.items.length} variação${data.items.length !== 1 ? 'ões' : ''} em estoque`}
          </CardHeader>

          {/* ── Mobile: cards ──────────────────────────────── */}
          <div className="md:hidden divide-y divide-border">
            {data.items.map((item, idx) => {
              const qty = item.current_qty ?? 0
              return (
                <div key={`${item.sku_variation}-${idx}`} className="px-4 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-text-primary truncate">{item.product_name}</p>
                      <p className="text-xs text-text-muted mt-0.5">
                        <code className="font-mono">{item.sku_variation}</code>
                        {(item.cor || item.tamanho) && (
                          <span className="ml-1.5">
                            {[item.cor, item.tamanho].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className={`text-lg font-bold tabular-nums ${
                        qty === 0 ? 'text-error' : qty <= 3 ? 'text-warning' : 'text-text-primary'
                      }`}>
                        {formatNumber(qty)}
                      </p>
                      <p className="text-[10px] text-text-muted leading-none">unidades</p>
                    </div>
                  </div>
                  <div className="flex gap-4 mt-2 text-xs text-text-muted">
                    <span>
                      Custo médio:{' '}
                      <span className="text-text-secondary font-medium">
                        {formatCurrency(item.avg_cost ?? 0)}
                      </span>
                    </span>
                    <span>
                      Venda:{' '}
                      <span className="text-text-secondary font-medium">
                        {formatCurrency(item.stock_value_at_price ?? 0)}
                      </span>
                    </span>
                  </div>
                  {item.last_entry_date && (
                    <p className="text-[11px] text-text-muted mt-1">
                      Entrada: {formatDate(item.last_entry_date)}
                    </p>
                  )}
                </div>
              )
            })}
          </div>

          {/* ── Desktop: tabela ─────────────────────────────── */}
          <div className="hidden md:block overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produto</TableHead>
                  <TableHead>Cor</TableHead>
                  <TableHead>Tamanho</TableHead>
                  <TableHead>SKU Variação</TableHead>
                  <TableHead>Qtd</TableHead>
                  <TableHead>Custo Médio</TableHead>
                  <TableHead>Valor Custo</TableHead>
                  <TableHead>Valor Venda</TableHead>
                  <TableHead>Última Entrada</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {data.items.map((item, idx) => (
                  <TableRow key={`${item.sku_variation}-${idx}`}>
                    <TableCell className="font-medium">
                      {item.product_name}
                    </TableCell>
                    <TableCell>{item.cor ?? '—'}</TableCell>
                    <TableCell>{item.tamanho ?? '—'}</TableCell>
                    <TableCell>
                      <code>{item.sku_variation}</code>
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