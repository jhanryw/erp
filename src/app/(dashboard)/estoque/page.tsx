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
import { EmptyState } from '@/components/ui/empty-state'
import { formatCurrency, formatNumber } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import { EstoqueSearch } from './estoque-search'
import { EstoqueMultiTable } from './estoque-multi-table'

export const dynamic = 'force-dynamic'

type MultiStockRow = {
  product_variation_id: number
  product_id: number
  product_name: string
  sku_variation: string
  sku_parent: string | null
  tamanho: string | null
  cor: string | null
  total_qty: number
  main_store_qty: number
  needs_transfer: boolean
  total_stock_value_at_cost: number | null
  last_entry_date: string | null
  balances_by_location: Array<{
    location_id: number
    location_name: string
    slug: string
    is_main_store: boolean
    priority: number
    quantity: number
  }>
}

type StockLocation = {
  id: number
  name: string
  slug: string
  is_main_store: boolean
  priority: number
}

async function getStockData(companyId: number, search?: string) {
  const supabase = createAdminClient()

  // Locais de estoque desta empresa
  const { data: locations } = await (supabase as any)
    .from('stock_locations')
    .select('id, name, slug, is_main_store, priority')
    .eq('company_id', companyId)
    .eq('active', true)
    .order('priority', { ascending: true }) as { data: StockLocation[] | null }

  // Variações com saldo (via vw_stock_live_multi)
  let query = (supabase as any)
    .from('vw_stock_live_multi')
    .select('*')
    .eq('company_id', companyId)
    .order('product_name', { ascending: true })

  if (search) {
    query = query.or(
      `product_name.ilike.%${search}%,sku_variation.ilike.%${search}%,sku_parent.ilike.%${search}%`
    )
  }

  const [{ data: items }, { data: allItems }] = await Promise.all([
    query,
    (supabase as any)
      .from('vw_stock_live_multi')
      .select('product_id, total_qty, total_stock_value_at_cost, main_store_qty, needs_transfer')
      .eq('company_id', companyId),
  ])

  const rows = (items ?? []) as MultiStockRow[]
  const all  = (allItems ?? []) as MultiStockRow[]
  const withStock = all.filter((r) => r.total_qty > 0)

  return {
    items: rows,
    locations: (locations ?? []) as StockLocation[],
    productCount:      new Set(withStock.map((r) => r.product_id)).size,
    totalQty:          withStock.reduce((s, r) => s + r.total_qty, 0),
    totalCostValue:    withStock.reduce((s, r) => s + Number(r.total_stock_value_at_cost ?? 0), 0),
    alertCount:        withStock.filter((r) => r.total_qty <= 3).length,
    needsTransferCount: all.filter((r) => r.needs_transfer).length,
  }
}

export default async function EstoquePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { q } = await searchParams
  const search = q?.trim() || undefined

  // Buscar company_id via admin client (usuário da sessão não disponível em server component sem cookies)
  const supabase = createAdminClient()
  const { data: firstCompany } = await (supabase as any)
    .from('companies')
    .select('id')
    .eq('active', true)
    .limit(1)
    .single() as { data: { id: number } | null }

  const companyId = firstCompany?.id ?? 1
  const data = await getStockData(companyId, search)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Estoque</h1>
          <p className="text-sm text-muted-foreground">
            Posição atual por local
          </p>
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
          title="Alertas"
          value={formatNumber(data.alertCount)}
          icon={<AlertTriangle className="h-4 w-4" />}
          valueClassName={data.alertCount > 0 ? 'text-warning' : undefined}
        />
        <StatCard
          title="Precisam Transferir"
          value={formatNumber(data.needsTransferCount)}
          icon={<Package className="h-4 w-4" />}
          valueClassName={data.needsTransferCount > 0 ? 'text-warning' : undefined}
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <Link href="/estoque/localizacoes">
          <Button variant="outline">Gerenciar Localizações</Button>
        </Link>
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
