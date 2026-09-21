/**
 * Catálogo público do site de atacado.
 *
 * Fonte de verdade 100% do ERP existente — `products`/`product_variations`/
 * `stock_balances`/`media_usages`, NENHUMA tabela de catálogo nova. Nunca
 * devolve o objeto cru de `products`/`product_variations`: só o DTO público
 * seguro (sem custo/margem/NCM/CST/estoque exato por padrão/IDs internos).
 *
 * Quem entra no catálogo: `products.company_id = empresa` AND
 * `products.active` AND `products.wholesale_enabled` (configuração explícita
 * do canal — nunca inferida de `wholesale_price`). Preço, estoque e
 * vendabilidade de cada variação vêm EXCLUSIVAMENTE de `./sellability`.
 *
 * Consulta (sem depender do limite de 1000 linhas do PostgREST — ver
 * `./queryBatching`): (1) lê só as colunas leves dos produtos candidatos
 * (habilitados, paginado no banco por `.range()`), (2) lê variações e estoque
 * deles em lotes, (3) decide quais produtos são visíveis e pagina, (4) só
 * então carrega atributos e imagens dos produtos DA PÁGINA — imagens em lote
 * (uma consulta por até 30 produtos, nunca uma por produto).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { listMediaByEntities } from '@/services/media.service'
import { getWholesaleSiteSettings, type WholesaleSiteSettings } from './settings'
import { selectAllInChunks, selectAllPages } from './queryBatching'
import { loadAttributesByVariation } from './attributes'
import { evaluateWholesaleSellability, loadWholesaleStockByVariation, type WholesaleSellability } from './sellability'

const LOW_STOCK_THRESHOLD = 3
/** Produtos por consulta de mídia em lote — mantém a resposta abaixo do limite de linhas. */
const MEDIA_BATCH_SIZE = 30

/**
 * Slug estável da categoria que deve aparecer primeiro na home do
 * catálogo — nunca um `category_id` numérico (que varia por
 * ambiente/empresa). Sem essa categoria, segue a ordem alfabética.
 */
export const WHOLESALE_PRIORITY_CATEGORY_SLUG = 'calcinhas'

export interface WholesaleCatalogVariation {
  variationId: number
  sku: string
  attributes: { type: string; value: string }[]
  price: number
  available: boolean
  lowStock: boolean
  /** Só preenchido quando a empresa habilita "mostrar quantidade disponível" (wholesale_site_settings.show_stock_quantity) — por padrão nunca expõe o número exato. */
  stockQuantity?: number
  /**
   * Quantidade máxima que o cliente pode pedir desta variação (estoque atual, 0 se não vendável).
   * Serve só pra limitar os botões +/- da interface — NÃO é exibida ao cliente a menos que
   * `stockQuantity` esteja habilitado. Só existe para variação vendável do catálogo público.
   */
  maxQuantity: number
}

export interface WholesaleCatalogProduct {
  productId: number
  name: string
  brand: string | null
  category: string | null
  /** Slug estável da categoria — usado pra ordenação de prioridade (Calcinhas) e link de navegação, nunca exibido cru. */
  categorySlug: string | null
  /** Capa primeiro (`primary`), depois `gallery` — vazio quando o produto não tem imagem válida. */
  images: { url: string; alt: string | null }[]
  variations: WholesaleCatalogVariation[]
  /** Menor preço entre as variações compráveis — pra exibição em listagem ("a partir de"). `null` quando nenhuma variação é vendável. */
  priceFrom: number | null
  /** false quando NENHUMA variação está vendável. */
  purchasable: boolean
}

interface CatalogFilters {
  search?: string
  categorySlug?: string
  /** Página 1-based. */
  page?: number
  pageSize?: number
}

export interface CatalogPage {
  products: WholesaleCatalogProduct[]
  total: number
  page: number
  pageSize: number
}

export interface WholesaleCategory {
  slug: string
  name: string
}

// ─── Tipos de linha ─────────────────────────────────────────────────────────

interface ProductRow {
  id: number
  name: string
  active: boolean
  wholesale_enabled: boolean
  wholesale_price: number | null
  brands: { name: string } | { name: string }[] | null
  categories: { name: string; slug: string } | { name: string; slug: string }[] | null
}

interface VariationRow {
  id: number
  product_id: number
  sku_variation: string
  active: boolean
  wholesale_price_override: number | null
}

function one<T>(embed: T | T[] | null | undefined): T | null {
  return Array.isArray(embed) ? (embed[0] ?? null) : (embed ?? null)
}

type Admin = ReturnType<typeof createAdminClient>

// ─── Carga de dados ─────────────────────────────────────────────────────────

/** Produtos candidatos: da empresa, ativos E habilitados no atacado (+ busca/categoria). Colunas leves; paginado por `.range()`. */
async function loadCandidateProducts(admin: Admin, companyId: number, filters: { search?: string; categorySlug?: string }): Promise<ProductRow[]> {
  // `!inner` só quando há filtro de categoria: sem ele o PostgREST filtra
  // apenas o objeto embutido (category vira null) e mantém TODOS os produtos.
  const categoryEmbed = filters.categorySlug ? 'categories:category_id!inner(name, slug)' : 'categories:category_id(name, slug)'

  return selectAllPages<ProductRow>((from, to) => {
    let query = (admin as any)
      .from('products')
      .select(`id, name, active, wholesale_enabled, wholesale_price, brands:brand_id(name), ${categoryEmbed}`)
      .eq('company_id', companyId)
      .eq('active', true)
      .eq('wholesale_enabled', true)

    if (filters.search) query = query.ilike('name', `%${filters.search}%`)
    if (filters.categorySlug) query = query.eq('categories.slug', filters.categorySlug)

    return query.order('name', { ascending: true }).order('id', { ascending: true }).range(from, to)
  })
}

async function loadVariations(admin: Admin, productIds: number[]): Promise<VariationRow[]> {
  return selectAllInChunks<VariationRow, number>(productIds, (chunk, from, to) =>
    (admin as any)
      .from('product_variations')
      .select('id, product_id, sku_variation, active, wholesale_price_override')
      .in('product_id', chunk)
      .eq('active', true)
      .order('id', { ascending: true })
      .range(from, to),
  )
}

/**
 * Imagens em LOTE (`listMediaByEntities`) — nunca uma consulta por produto.
 * Ordem da capa: `primary` primeiro, depois `gallery` (por `position`);
 * mídia inativa é ignorada. Sem imagem válida → lista vazia (a UI mostra o placeholder).
 */
async function loadImagesByProduct(companyId: number, productIds: number[]): Promise<Record<number, { url: string; alt: string | null }[]>> {
  const byProduct: Record<number, { url: string; alt: string | null }[]> = {}

  for (let i = 0; i < productIds.length; i += MEDIA_BATCH_SIZE) {
    const batch = productIds.slice(i, i + MEDIA_BATCH_SIZE)
    const result = await listMediaByEntities('product', batch.map(String), companyId)
    if (!result.ok) continue

    const usable = result.data.filter((m) => (m.role === 'primary' || m.role === 'gallery') && m.active !== false)
    const rank = (role: string) => (role === 'primary' ? 0 : 1)
    usable.sort((a, b) => rank(a.role) - rank(b.role) || a.position - b.position)

    for (const m of usable) {
      const productId = Number(m.entity_id)
      const list = byProduct[productId] ?? []
      list.push({ url: m.url, alt: m.alt_text })
      byProduct[productId] = list
    }
  }
  return byProduct
}

// ─── Montagem ───────────────────────────────────────────────────────────────

interface EvaluatedVariation {
  row: VariationRow
  result: WholesaleSellability
}

function evaluateVariations(
  product: ProductRow,
  variations: VariationRow[],
  stockByVariation: Record<number, number>,
): EvaluatedVariation[] {
  return variations.map((row) => ({
    row,
    result: evaluateWholesaleSellability({
      product,
      variation: row,
      stock: stockByVariation[row.id] ?? 0,
    }),
  }))
}

function toCatalogProduct(
  product: ProductRow,
  evaluated: EvaluatedVariation[],
  attrsByVariation: Record<number, { type: string; value: string }[]>,
  images: { url: string; alt: string | null }[],
  showStockQuantity: boolean,
): WholesaleCatalogProduct {
  const catalogVariations: WholesaleCatalogVariation[] = evaluated.map(({ row, result }) => ({
    variationId: row.id,
    sku: row.sku_variation,
    attributes: attrsByVariation[row.id] ?? [],
    price: result.price ?? 0,
    available: result.sellable,
    maxQuantity: result.sellable ? result.stock : 0,
    lowStock: result.sellable && result.stock <= LOW_STOCK_THRESHOLD,
    ...(showStockQuantity ? { stockQuantity: result.stock } : {}),
  }))

  const sellablePrices = catalogVariations.filter((v) => v.available).map((v) => v.price)
  const category = one(product.categories)

  return {
    productId: product.id,
    name: product.name,
    brand: one(product.brands)?.name ?? null,
    category: category?.name ?? null,
    categorySlug: category?.slug ?? null,
    images,
    variations: catalogVariations,
    priceFrom: sellablePrices.length > 0 ? Math.min(...sellablePrices) : null,
    purchasable: sellablePrices.length > 0,
  }
}

interface VisibleProduct {
  product: ProductRow
  evaluated: EvaluatedVariation[]
}

/** Produtos visíveis na vitrine, já na ordem final (alfabética; Calcinhas primeiro fora de busca/categoria). */
async function resolveVisibleProducts(
  admin: Admin,
  companyId: number,
  settings: WholesaleSiteSettings,
  filters: { search?: string; categorySlug?: string },
): Promise<VisibleProduct[]> {
  const candidates = await loadCandidateProducts(admin, companyId, filters)
  if (candidates.length === 0) return []

  const variations = await loadVariations(admin, candidates.map((p) => p.id))
  const stockByVariation = await loadWholesaleStockByVariation(admin, companyId, variations.map((v) => v.id))

  const variationsByProduct = new Map<number, VariationRow[]>()
  for (const v of variations) {
    const list = variationsByProduct.get(v.product_id) ?? []
    list.push(v)
    variationsByProduct.set(v.product_id, list)
  }

  const all: VisibleProduct[] = candidates.map((product) => ({
    product,
    evaluated: evaluateVariations(product, variationsByProduct.get(product.id) ?? [], stockByVariation),
  }))

  // Por padrão a vitrine não mostra produto sem nenhuma variação vendável —
  // configurável via wholesale_site_settings.show_out_of_stock.
  const visible = settings.showOutOfStock ? all : all.filter((p) => p.evaluated.some((e) => e.result.sellable))

  // Sort estável: dentro de cada grupo a ordem alfabética da query é preservada.
  const priority = (p: VisibleProduct) => (one(p.product.categories)?.slug === WHOLESALE_PRIORITY_CATEGORY_SLUG ? 0 : 1)
  return filters.search || filters.categorySlug ? visible : [...visible].sort((a, b) => priority(a) - priority(b))
}

// ─── API do módulo ──────────────────────────────────────────────────────────

export async function getWholesaleCatalogPage(companyId: number, filters: CatalogFilters = {}): Promise<CatalogPage> {
  const admin = createAdminClient()
  const settings = await getWholesaleSiteSettings(companyId)
  const page = Math.max(1, filters.page ?? 1)
  const pageSize = Math.min(60, Math.max(1, filters.pageSize ?? 24))
  const offset = (page - 1) * pageSize

  const visible = await resolveVisibleProducts(admin, companyId, settings, { search: filters.search, categorySlug: filters.categorySlug })
  const total = visible.length
  const pageItems = visible.slice(offset, offset + pageSize)
  if (pageItems.length === 0) return { products: [], total, page, pageSize }

  const variationIds = pageItems.flatMap((p) => p.evaluated.map((e) => e.row.id))
  const [attrsByVariation, imagesByProduct] = await Promise.all([
    loadAttributesByVariation(admin as any, variationIds),
    loadImagesByProduct(companyId, pageItems.map((p) => p.product.id)),
  ])

  const products = pageItems.map(({ product, evaluated }) =>
    toCatalogProduct(product, evaluated, attrsByVariation, imagesByProduct[product.id] ?? [], settings.showStockQuantity),
  )
  return { products, total, page, pageSize }
}

/**
 * Categorias com pelo menos 1 produto VISÍVEL no catálogo (mesma regra da
 * vitrine — nunca mostra categoria vazia nem categoria só com produto fora do atacado).
 */
export async function listWholesaleCategories(companyId: number): Promise<WholesaleCategory[]> {
  const admin = createAdminClient()
  const settings = await getWholesaleSiteSettings(companyId)
  const visible = await resolveVisibleProducts(admin, companyId, settings, {})

  const categories = new Map<string, WholesaleCategory>()
  for (const { product } of visible) {
    const category = one(product.categories)
    if (category?.slug && !categories.has(category.slug)) categories.set(category.slug, { slug: category.slug, name: category.name })
  }

  return Array.from(categories.values()).sort((a, b) => {
    const aPriority = a.slug === WHOLESALE_PRIORITY_CATEGORY_SLUG ? 0 : 1
    const bPriority = b.slug === WHOLESALE_PRIORITY_CATEGORY_SLUG ? 0 : 1
    if (aPriority !== bPriority) return aPriority - bPriority
    return a.name.localeCompare(b.name, 'pt-BR')
  })
}

/** `null` (→ 404) quando o produto não existe, é de outra empresa, está inativo OU não está habilitado no atacado. */
export async function getWholesaleProductDetail(companyId: number, productId: number): Promise<WholesaleCatalogProduct | null> {
  const admin = createAdminClient()
  const settings = await getWholesaleSiteSettings(companyId)

  const { data: product, error } = await (admin as any)
    .from('products')
    .select('id, name, active, wholesale_enabled, wholesale_price, brands:brand_id(name), categories:category_id(name, slug)')
    .eq('company_id', companyId)
    .eq('id', productId)
    .eq('active', true)
    .eq('wholesale_enabled', true)
    .maybeSingle() as { data: ProductRow | null; error: { message: string } | null }

  if (error) throw new Error(`Falha ao consultar o produto de atacado: ${error.message}`)
  if (!product) return null

  const variations = await loadVariations(admin, [productId])
  const variationIds = variations.map((v) => v.id)
  const [stockByVariation, attrsByVariation, imagesByProduct] = await Promise.all([
    loadWholesaleStockByVariation(admin, companyId, variationIds),
    loadAttributesByVariation(admin as any, variationIds),
    loadImagesByProduct(companyId, [productId]),
  ])

  return toCatalogProduct(
    product,
    evaluateVariations(product, variations, stockByVariation),
    attrsByVariation,
    imagesByProduct[productId] ?? [],
    settings.showStockQuantity,
  )
}
