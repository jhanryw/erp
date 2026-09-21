/**
 * Dados da página /estoque (posição multi-local) — sempre escopados pela
 * empresa da SESSÃO e, opcionalmente, por fornecedor.
 *
 * Filtro por fornecedor: cadeia real `stock → variação → produto → supplier_id`.
 * A view `vw_stock_live_multi` já traz `product_id`/`company_id` por variação
 * (não traz supplier_id, e não duplicamos a coluna): os ids de produto do
 * fornecedor saem de UMA consulta em `products` (filtrada por empresa) e a
 * view é lida em lotes com `product_id IN (...)`. Nada de consulta por linha
 * e nada de filtrar no front. Todas as leituras paginam por `.range()` (a view
 * passa de 1000 linhas — o limite do PostgREST truncaria lista e totais).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { selectAllInChunks, selectAllPages } from './wholesale/queryBatching'
import { sanitizePostgrestSearch } from '@/lib/utils/postgrest-search'

export type LocationBalance = {
  location_id: number
  location_name: string
  slug: string
  is_main_store: boolean
  priority: number
  quantity: number
}

export type MultiStockRow = {
  product_variation_id: number
  product_id: number
  product_name: string
  sku_variation: string
  sku_parent: string | null
  tamanho: string | null
  cor: string | null
  company_id: number
  total_qty: number
  main_store_qty: number
  needs_transfer: boolean
  total_stock_value_at_cost: number | null
  total_stock_value_at_price: number | null
  last_entry_date: string | null
  balances_by_location: LocationBalance[]
}

export type StockLocation = { id: number; name: string; slug: string; is_main_store: boolean; priority: number }

export interface StockListFilters {
  search?: string
  /** `products.supplier_id` */
  supplierId?: number
}

export interface StockListData {
  items: MultiStockRow[]
  locations: StockLocation[]
  productCount: number
  totalQty: number
  totalCostValue: number
  totalSaleValue: number
  alertCount: number
  needsTransferCount: number
}

const SUMMARY_COLUMNS = 'product_id, total_qty, main_store_qty, needs_transfer, total_stock_value_at_cost, total_stock_value_at_price'

/** nulls por último, texto pt-BR — mesma intenção do ORDER BY da view (`product_name, tamanho, cor`). */
function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a == null) return 1
  if (b == null) return -1
  return a.localeCompare(b, 'pt-BR')
}

export async function getMultiStockData(admin: SupabaseClient, companyId: number, filters: StockListFilters = {}): Promise<StockListData> {
  const search = filters.search ? sanitizePostgrestSearch(filters.search) : ''

  // Locais ATIVOS da empresa (antes vinham de todas as empresas).
  const locationsPromise = (async () => {
    const { data, error } = await (admin as any)
      .from('stock_locations')
      .select('id, name, slug, is_main_store, priority')
      .eq('company_id', companyId)
      .eq('active', true)
      .order('priority', { ascending: true }) as { data: StockLocation[] | null; error: { message: string } | null }
    if (error) throw new Error(`Falha ao listar locais de estoque: ${error.message}`)
    return data ?? []
  })()

  // Fornecedor → ids dos produtos DA EMPRESA (uma consulta). Fornecedor sem produto / de outra empresa → vazio.
  let productIds: number[] | undefined
  if (filters.supplierId !== undefined) {
    const rows = await selectAllPages<{ id: number }>((from, to) =>
      (admin as any)
        .from('products')
        .select('id')
        .eq('company_id', companyId)
        .eq('supplier_id', filters.supplierId)
        .order('id', { ascending: true })
        .range(from, to),
    )
    productIds = rows.map((r) => r.id)
  }

  const locations = await locationsPromise
  if (productIds && productIds.length === 0) {
    return { items: [], locations, productCount: 0, totalQty: 0, totalCostValue: 0, totalSaleValue: 0, alertCount: 0, needsTransferCount: 0 }
  }

  /** Lê a view da empresa (todas as páginas), restrita aos produtos do fornecedor quando houver. */
  async function readView<T>(columns: string, opts: { withSearch: boolean; order: string[] }): Promise<T[]> {
    const build = (ids: number[] | undefined) => (from: number, to: number) => {
      let query = (admin as any).from('vw_stock_live_multi').select(columns).eq('company_id', companyId)
      if (ids) query = query.in('product_id', ids)
      if (opts.withSearch && search) {
        query = query.or(`product_name.ilike.%${search}%,sku_variation.ilike.%${search}%,sku_parent.ilike.%${search}%`)
      }
      for (const col of opts.order) query = query.order(col, { ascending: true })
      return query.range(from, to)
    }
    return productIds
      ? selectAllInChunks<T, number>(productIds, (chunk, from, to) => build(chunk)(from, to))
      : selectAllPages<T>(build(undefined))
  }

  const [items, all] = await Promise.all([
    readView<MultiStockRow>('*', { withSearch: true, order: ['product_name', 'tamanho', 'cor', 'product_variation_id'] }),
    readView<MultiStockRow>(SUMMARY_COLUMNS, { withSearch: false, order: ['product_variation_id'] }),
  ])

  // Com fornecedor a leitura é em lotes de produtos → reordena no fim (sem fornecedor o banco já entrega ordenado).
  if (productIds) {
    items.sort((a, b) =>
      compareNullable(a.product_name, b.product_name) || compareNullable(a.tamanho, b.tamanho) || compareNullable(a.cor, b.cor) ||
      a.product_variation_id - b.product_variation_id)
  }

  const withStock = all.filter((r) => Number(r.total_qty ?? 0) > 0)
  return {
    items,
    locations,
    productCount: new Set(withStock.map((r) => r.product_id)).size,
    totalQty: withStock.reduce((s, r) => s + Number(r.total_qty), 0),
    totalCostValue: withStock.reduce((s, r) => s + Number(r.total_stock_value_at_cost ?? 0), 0),
    totalSaleValue: withStock.reduce((s, r) => s + Number(r.total_stock_value_at_price ?? 0), 0),
    alertCount: all.filter((r) => Number(r.total_qty) > 0 && Number(r.total_qty) <= 3).length,
    needsTransferCount: all.filter((r) => r.needs_transfer).length,
  }
}
