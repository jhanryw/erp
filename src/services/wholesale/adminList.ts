/**
 * Listagem administrativa de produtos com o status do atacado.
 *
 * Performance: o status é calculado EM LOTE (`loadWholesaleAdminSummaries`)
 * — nunca uma consulta por produto.
 *   - Sem filtro de "situação": paginação no banco (`.range()` + count) e o
 *     status só é calculado para os produtos DA PÁGINA (~50).
 *   - Com filtro de situação (vendável / sem preço / sem estoque / sem
 *     imagem): a situação depende de variações+estoque+imagens, então o
 *     status é calculado, em lote, para os produtos HABILITADOS no atacado
 *     (conjunto curado, não o cadastro inteiro), filtrado e paginado em
 *     memória sobre ids leves.
 *
 * Tenant: TODA consulta filtra `company_id`.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { selectAllPages } from './queryBatching'
import { loadWholesaleAdminSummaries, type WholesaleProductSummary } from './adminStatus'
import { sanitizePostgrestSearch } from '@/lib/utils/postgrest-search'

export const ADMIN_PAGE_SIZE = 50

export type AtacadoFilter = 'ativos' | 'inativos'
export type SituacaoFilter = 'vendaveis' | 'sem_preco' | 'sem_estoque' | 'sem_imagem'

export const ATACADO_FILTERS: AtacadoFilter[] = ['ativos', 'inativos']
export const SITUACAO_FILTERS: SituacaoFilter[] = ['vendaveis', 'sem_preco', 'sem_estoque', 'sem_imagem']

export interface AdminListFilters {
  search?: string
  atacado?: AtacadoFilter
  situacao?: SituacaoFilter
  /** `products.supplier_id` — filtra no banco, junto com todos os demais filtros. */
  supplierId?: number
  page?: number
}

export interface AdminProductRow {
  id: number
  name: string
  sku: string
  base_cost: number
  base_price: number
  margin_pct: number
  photo_url: string | null
  active: boolean
  wholesale_enabled: boolean
  wholesale_price: number | null
  /** 'kit' = produto composto (estoque derivado). Ausente em linhas antigas de teste → tratado como standard. */
  product_kind?: 'standard' | 'kit'
  categories: { id: number; name: string } | { id: number; name: string }[] | null
  suppliers: { id: number; name: string } | { id: number; name: string }[] | null
  brands: { id: number; name: string } | { id: number; name: string }[] | null
}

export interface AdminListResult {
  products: AdminProductRow[]
  summaries: Map<number, WholesaleProductSummary>
  total: number
  page: number
  totalPages: number
}

const FULL_COLUMNS = `id, name, sku, base_cost, base_price, margin_pct, photo_url, active, wholesale_enabled, wholesale_price, product_kind,
             categories:category_id (id, name), suppliers:supplier_id (id, name), brands:brand_id (id, name)`

function baseQuery(admin: SupabaseClient, companyId: number, columns: string, filters: AdminListFilters, enabled: boolean | undefined, withCount = false) {
  let query = (admin as any)
    .from('products')
    .select(columns, withCount ? { count: 'exact' } : undefined)
    .eq('company_id', companyId)

  if (enabled !== undefined) query = query.eq('wholesale_enabled', enabled)
  if (filters.supplierId !== undefined) query = query.eq('supplier_id', filters.supplierId)
  const search = filters.search ? sanitizePostgrestSearch(filters.search) : ''
  if (search) query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%`)
  return query.order('name', { ascending: true }).order('id', { ascending: true })
}

function matchesSituacao(summary: WholesaleProductSummary, situacao: SituacaoFilter): boolean {
  switch (situacao) {
    case 'vendaveis': return summary.status === 'sellable'
    case 'sem_preco': return summary.status === 'no_price'
    case 'sem_estoque': return summary.status === 'no_stock'
    case 'sem_imagem': return !summary.hasImage
  }
}

export async function listProductsForAdmin(admin: SupabaseClient, companyId: number, filters: AdminListFilters): Promise<AdminListResult> {
  const requestedPage = Math.max(1, filters.page ?? 1)
  const offset = (requestedPage - 1) * ADMIN_PAGE_SIZE

  // "Situação" só faz sentido para produtos habilitados no atacado.
  const enabled: boolean | undefined = filters.situacao ? true : filters.atacado === 'ativos' ? true : filters.atacado === 'inativos' ? false : undefined
  if (filters.situacao && filters.atacado === 'inativos') {
    return { products: [], summaries: new Map(), total: 0, page: 1, totalPages: 1 }
  }

  if (!filters.situacao) {
    const { data, count, error } = await baseQuery(admin, companyId, FULL_COLUMNS, filters, enabled, true).range(offset, offset + ADMIN_PAGE_SIZE - 1) as
      { data: AdminProductRow[] | null; count: number | null; error: { message: string } | null }
    if (error) throw new Error(`Falha ao listar produtos: ${error.message}`)

    const products = data ?? []
    const total = count ?? products.length
    const summaries = await loadWholesaleAdminSummaries(admin, companyId, products)
    return { products, summaries, total, page: requestedPage, totalPages: Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE)) }
  }

  // Com filtro de situação: candidatos leves (habilitados) → status em lote → filtra → pagina.
  const candidates = await selectAllPages<{ id: number; active: boolean; wholesale_enabled: boolean; wholesale_price: number | null }>((from, to) =>
    baseQuery(admin, companyId, 'id, active, wholesale_enabled, wholesale_price', filters, true).range(from, to),
  )
  const allSummaries = await loadWholesaleAdminSummaries(admin, companyId, candidates)
  const matchingIds = candidates.filter((c) => matchesSituacao(allSummaries.get(c.id)!, filters.situacao!)).map((c) => c.id)

  const total = matchingIds.length
  const pageIds = matchingIds.slice(offset, offset + ADMIN_PAGE_SIZE)
  let products: AdminProductRow[] = []
  if (pageIds.length > 0) {
    const { data, error } = await (admin as any)
      .from('products')
      .select(FULL_COLUMNS)
      .eq('company_id', companyId)
      .in('id', pageIds)
      .order('name', { ascending: true })
      .order('id', { ascending: true }) as { data: AdminProductRow[] | null; error: { message: string } | null }
    if (error) throw new Error(`Falha ao listar produtos: ${error.message}`)
    products = data ?? []
  }

  return { products, summaries: allSummaries, total, page: requestedPage, totalPages: Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE)) }
}
