import { Suspense } from 'react'
import Link from 'next/link'
import {
  Plus,
  Warehouse,
  AlertTriangle,
  DollarSign,
  Boxes,
} from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCurrency, formatNumber } from '@/lib/utils/currency'
import { EstoqueSearch } from './estoque-search'
import { EstoqueMultiTable } from './estoque-multi-table'

export const dynamic = 'force-dynamic'

// Colunas disponíveis na vw_stock_live (view original, lê da tabela stock)
type LiveRow = {
  product_variation_id: number
  product_id: number
  product_name: string
  sku_variation: string
  sku_parent: string | null
  tamanho: string | null
  cor: string | null
  quantity: number
  avg_cost: number | null
  total_stock_value_at_cost: number | null
  last_entry_date: string | null
}

async function getStockData(search?: string) {
  const supabase = createAdminClient()

  let query = supabase
    .from('vw_stock_live')
    .select('*')
    .order('product_name', { ascending: true })

  if (search) {
    query = query.or(
      `product_name.ilike.%${search}%,sku_variation.ilike.%${search}%,sku_parent.ilike.%${search}%`
    )
  }

  const [{ data: items }, { data: allItems }] = await Promise.all([
    query,
    supabase
      .from('vw_stock_live')
      .select('product_id, quantity, total_stock_value_at_cost'),
  ])

  const rows  = (items ?? []) as LiveRow[]
  const all   = (allItems ?? []) as Pick<LiveRow, 'product_id' | 'quantity' | 'total_stock_value_at_cost'>[]
  const withStock = all.filter((r) => r.quantity > 0)

  // Adaptar para o formato esperado pelo EstoqueMultiTable
  // Uma única localização sintética "Estoque Loja" para compatibilidade
  const mainStoreLoc = { id: 0, name: 'Estoque Loja', slug: 'loja', is_main_store: true, priority: 1 }

  const tableRows = rows.map((r) => ({
    product_variation_id:     r.product_variation_id,
    product_id:               r.product_id,
    product_name:             r.product_name,
    sku_variation:            r.sku_variation,
    sku_parent:               r.sku_parent,
    tamanho:                  r.tamanho,
    cor:                      r.cor,
    total_qty:                r.quantity,
    main_store_qty:           r.quantity,
    needs_transfer:           false,
    total_stock_value_at_cost: r.total_stock_value_at_cost,
    last_entry_date:          r.last_entry_date,
    balances_by_location: [{
      location_id:   mainStoreLoc.id,
      location_name: mainStoreLoc.name,
      slug:          mainStoreLoc.slug,
      is_main_store: true,
      priority:      1,
      quantity:      r.quantity,
    }],
  }))

  return {
    items:          tableRows,
    locations:      [mainStoreLoc],
    productCount:   new Set(withStock.map((r) => r.product_id)).size,
    totalQty:       withStock.reduce((s, r) => s + r.quantity, 0),
    totalCostValue: withStock.reduce((s, r) => s + Number(r.total_stock_value_at_cost ?? 0), 0),
    alertCount:     withStock.filter((r) => r.quantity <= 3).length,
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

        <div className="flex gap-2 flex-wrap justify-end">
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

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
          title="Alertas (≤ 3 un)"
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
        <EstoqueMultiTable
          items={data.items}
          locations={data.locations}
        />
      )}
    </div>
  )
}
