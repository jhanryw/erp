import { Suspense } from 'react'
import Link from 'next/link'
import {
  Plus,
  Warehouse,
  AlertTriangle,
  Package,
  DollarSign,
  Boxes,
  ClipboardList,
  ArrowLeftRight,
} from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCurrency, formatNumber } from '@/lib/utils/currency'
import { EstoqueSearch } from './estoque-search'
import { EstoqueMultiTable } from './estoque-multi-table'

export const dynamic = 'force-dynamic'

// ─── Tipos (espelham vw_stock_live_multi + stock_locations) ──────────────────

type LocationBalance = {
  location_id:   number
  location_name: string
  slug:          string
  is_main_store: boolean
  priority:      number
  quantity:      number
}

type MultiStockRow = {
  product_variation_id:       number
  product_id:                 number
  product_name:               string
  sku_variation:              string
  sku_parent:                 string | null
  tamanho:                    string | null
  cor:                        string | null
  company_id:                 number
  total_qty:                  number
  main_store_qty:             number
  needs_transfer:             boolean
  total_stock_value_at_cost:  number | null
  total_stock_value_at_price: number | null
  last_entry_date:            string | null
  balances_by_location:       LocationBalance[]
}

type StockLocation = {
  id:            number
  name:          string
  slug:          string
  is_main_store: boolean
  priority:      number
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function getMultiStockData(search?: string) {
  const supabase = createAdminClient()

  let itemsQuery = (supabase as any)
    .from('vw_stock_live_multi')
    .select('*')
    .order('product_name', { ascending: true })
    .order('tamanho',      { ascending: true })
    .order('cor',          { ascending: true })

  if (search) {
    itemsQuery = itemsQuery.or(
      `product_name.ilike.%${search}%,sku_variation.ilike.%${search}%,sku_parent.ilike.%${search}%`,
    )
  }

  const [stockResult, summaryResult, locationsResult] = await Promise.all([
    itemsQuery,
    // Summary sem filtro de busca para stat cards sempre refletirem o total
    (supabase as any)
      .from('vw_stock_live_multi')
      .select('product_id, total_qty, main_store_qty, needs_transfer, total_stock_value_at_cost, total_stock_value_at_price'),
    (supabase as any)
      .from('stock_locations')
      .select('id, name, slug, is_main_store, priority')
      .eq('active', true)
      .order('priority', { ascending: true }),
  ])

  const items     = (stockResult.data     ?? []) as MultiStockRow[]
  const all       = (summaryResult.data   ?? []) as MultiStockRow[]
  const locations = (locationsResult.data ?? []) as StockLocation[]

  const withStock = all.filter((r) => Number(r.total_qty ?? 0) > 0)

  return {
    items,
    locations,
    productCount:      new Set(withStock.map((r) => r.product_id)).size,
    totalQty:          withStock.reduce((s, r) => s + Number(r.total_qty),                  0),
    totalCostValue:    withStock.reduce((s, r) => s + Number(r.total_stock_value_at_cost  ?? 0), 0),
    totalSaleValue:    withStock.reduce((s, r) => s + Number(r.total_stock_value_at_price ?? 0), 0),
    alertCount:        all.filter((r) => Number(r.total_qty) > 0 && Number(r.total_qty) <= 3).length,
    needsTransferCount: all.filter((r) => r.needs_transfer).length,
  }
}

// ─── Página ───────────────────────────────────────────────────────────────────

export default async function EstoquePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { q } = await searchParams
  const search = q?.trim() || undefined
  const data = await getMultiStockData(search)

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Estoque</h1>
          <p className="text-sm text-muted-foreground">
            {data.locations.length > 1
              ? `${data.locations.length} locais ativos`
              : 'Posição atual'}
          </p>
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

      {/* ── Alerta: produtos que precisam de transferência ── */}
      {data.needsTransferCount > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/8 px-4 py-3">
          <AlertTriangle className="h-5 w-5 text-warning mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-warning">
              {data.needsTransferCount} produto{data.needsTransferCount !== 1 ? 's' : ''} com
              estoque em local secundário mas sem saldo no Estoque Loja
            </p>
            <p className="text-xs text-text-secondary mt-0.5">
              Esses produtos não podem ser vendidos presencialmente até que o estoque seja
              transferido para o Estoque Loja. Use o botão "Transferir" na linha do produto.
            </p>
          </div>
        </div>
      )}

      {/* ── Stat cards ── */}
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

      {/* ── Botões de ação ── */}
      <div className="flex flex-wrap gap-3">
        <Link href="/estoque/movimentacoes">
          <Button variant="outline">Ver Movimentações</Button>
        </Link>
        <Link href="/estoque/ajuste">
          <Button variant="outline">Ajuste de Estoque</Button>
        </Link>
        <Link href="/estoque/inventario">
          <Button variant="outline">
            <ClipboardList className="mr-2 h-4 w-4" />
            Conferir Estoque
          </Button>
        </Link>
        {data.locations.length > 1 && (
          <>
            <Link href="/estoque/transferencia-em-massa">
              <Button variant="outline">
                <ArrowLeftRight className="mr-2 h-4 w-4" />
                Transferência em Massa
              </Button>
            </Link>
            <Link href="/estoque/localizacoes">
              <Button variant="outline">
                Gerenciar Locais
              </Button>
            </Link>
          </>
        )}
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

      {/* ── Busca ── */}
      <Suspense>
        <EstoqueSearch defaultValue={q} />
      </Suspense>

      {/* ── Tabela / empty state ── */}
      {data.items.length === 0 ? (
        <EmptyState
          icon={<Warehouse className="h-4 w-4" />}
          title="Estoque vazio"
          description="Registre a primeira entrada de estoque."
          action={{ label: 'Registrar entrada', href: '/estoque/entrada' }}
        />
      ) : (
        <EstoqueMultiTable items={data.items} locations={data.locations} />
      )}
    </div>
  )
}
