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
import { cachedForCompany, timed } from '@/lib/wholesale/ttlCache'
import { rankBySeed, RECOMMENDATION_MAX } from './recommendations'
import { loadCategoryUniverse, resolveCategoryKey } from './categoryKeys'
import { loadCategoryCovers } from './categoryCovers'
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
  id: number
  slug: string
  name: string
  /** Valor de `?categoria=` — o slug, ou `slug~id` quando o slug se repete na empresa (ver categoryKeys.ts). */
  key: string
  /** Foto da home: capa configurada no ERP ou, na falta dela, a foto de um produto da categoria. `null` → card tipográfico. */
  imageUrl: string | null
  imageAlt: string | null
  /** Origem da foto: `cover` (upload do ERP, sempre no Storage → otimizável pelo next/image) ou `product` (pode vir de URL externa). */
  imageSource: 'cover' | 'product' | null
  productCount: number
}

// ─── Tipos de linha ─────────────────────────────────────────────────────────

interface ProductRow {
  id: number
  name: string
  active: boolean
  wholesale_enabled: boolean
  wholesale_price: number | null
  category_id: number | null
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
async function loadCandidateProducts(admin: Admin, companyId: number): Promise<ProductRow[]> {
  return selectAllPages<ProductRow>((from, to) =>
    (admin as any)
      .from('products')
      .select('id, name, active, wholesale_enabled, wholesale_price, category_id, brands:brand_id(name), categories:category_id(name, slug)')
      .eq('company_id', companyId)
      .eq('active', true)
      .eq('wholesale_enabled', true)
      .order('name', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
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

/**
 * TODOS os produtos visíveis da empresa (ordem alfabética), com variações, preço e estoque avaliados.
 * É a carga cara (produtos + variações + estoque): fica em cache curto por empresa (ver ttlCache.ts) e a
 * chave inclui `showOutOfStock`, que muda quem é visível. Busca e categoria filtram ESTA lista em memória —
 * a mesma regra de visibilidade para vitrine, categorias e recomendações, sem refazer a carga a cada filtro.
 */
async function loadAllVisibleProducts(admin: Admin, companyId: number, settings: WholesaleSiteSettings): Promise<VisibleProduct[]> {
  return cachedForCompany(companyId, `visible:${settings.showOutOfStock ? 1 : 0}`, () =>
    timed('visible-products', companyId, async () => {
      const candidates = await timed('products', companyId, () => loadCandidateProducts(admin, companyId))
      if (candidates.length === 0) return []

      const variations = await timed('variations', companyId, () => loadVariations(admin, candidates.map((p) => p.id)))
      const stockByVariation = await timed('stock', companyId, () => loadWholesaleStockByVariation(admin, companyId, variations.map((v) => v.id)))

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
      return settings.showOutOfStock ? all : all.filter((p) => p.evaluated.some((e) => e.result.sellable))
    }),
  )
}

/** Universo de categorias da empresa (cache curto — muda raramente). */
function loadCachedCategoryUniverse(admin: Admin, companyId: number) {
  return cachedForCompany(companyId, 'category-universe', () => loadCategoryUniverse(admin, companyId))
}

/** Produtos visíveis na vitrine, já na ordem final (alfabética; Calcinhas primeiro fora de busca/categoria). */
async function resolveVisibleProducts(
  admin: Admin,
  companyId: number,
  settings: WholesaleSiteSettings,
  filters: { search?: string; categorySlug?: string },
): Promise<VisibleProduct[]> {
  let categoryId: number | undefined
  if (filters.categorySlug) {
    // `categorySlug` é a chave pública (slug, ou slug~id quando repetido). Chave desconhecida/inativa → vitrine vazia.
    const universe = await loadCachedCategoryUniverse(admin, companyId)
    const category = resolveCategoryKey(universe.filter((c) => c.active), filters.categorySlug)
    if (!category) return []
    categoryId = category.id
  }

  let visible = await loadAllVisibleProducts(admin, companyId, settings)

  if (filters.search) {
    const needle = filters.search.toLowerCase()
    visible = visible.filter((v) => v.product.name.toLowerCase().includes(needle))
  }
  // Filtro pela COLUNA category_id (identidade real) — nunca pelo slug, que pode se repetir na empresa.
  if (categoryId != null) visible = visible.filter((v) => v.product.category_id === categoryId)

  // Sort estável: dentro de cada grupo a ordem alfabética é preservada.
  const priority = (p: VisibleProduct) => (one(p.product.categories)?.slug === WHOLESALE_PRIORITY_CATEGORY_SLUG ? 0 : 1)
  return filters.search || filters.categorySlug ? visible : [...visible].sort((a, b) => priority(a) - priority(b))
}

// ─── API do módulo ──────────────────────────────────────────────────────────

async function buildCatalogPage(companyId: number, filters: CatalogFilters, settings: WholesaleSiteSettings): Promise<CatalogPage> {
  const admin = createAdminClient()
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
 * Página do catálogo. Sem busca, a página montada (com imagens e atributos) entra no cache curto por empresa —
 * é o caso das visitas de campanha (home, categoria, paginação). Busca livre nunca é cacheada (chave ilimitada).
 * Preço/estoque/disponibilidade continuam revalidados no servidor na validação do carrinho e no pedido.
 */
export async function getWholesaleCatalogPage(companyId: number, filters: CatalogFilters = {}): Promise<CatalogPage> {
  const settings = await getWholesaleSiteSettings(companyId)
  if (filters.search) return buildCatalogPage(companyId, filters, settings)

  const key = [
    'page', filters.categorySlug ?? '-', Math.max(1, filters.page ?? 1), filters.pageSize ?? 24,
    settings.showOutOfStock ? 1 : 0, settings.showStockQuantity ? 1 : 0,
  ].join(':')
  return cachedForCompany(companyId, key, () => timed('catalog-page', companyId, () => buildCatalogPage(companyId, filters, settings)))
}

/**
 * Categorias com pelo menos 1 produto VISÍVEL no catálogo (mesma regra da vitrine — nunca mostra
 * categoria vazia, inativa nem categoria só com produto fora do atacado). Cada categoria sai com a
 * chave pública única e, com `withImages`, a foto do card: capa do ERP → foto de um produto → nenhuma.
 */
export async function listWholesaleCategories(companyId: number, options: { withImages?: boolean } = {}): Promise<WholesaleCategory[]> {
  const settings = await getWholesaleSiteSettings(companyId)
  const key = `categories:${options.withImages ? 1 : 0}:${settings.showOutOfStock ? 1 : 0}`
  return cachedForCompany(companyId, key, () => timed('categories', companyId, () => buildCategories(companyId, options, settings)))
}

async function buildCategories(companyId: number, options: { withImages?: boolean }, settings: WholesaleSiteSettings): Promise<WholesaleCategory[]> {
  const admin = createAdminClient()
  const [visible, universe] = await Promise.all([
    resolveVisibleProducts(admin, companyId, settings, {}),
    loadCachedCategoryUniverse(admin, companyId),
  ])

  const byId = new Map(universe.filter((c) => c.active).map((c) => [c.id, c]))
  const productsByCategory = new Map<number, number[]>()
  for (const { product } of visible) {
    if (product.category_id == null || !byId.has(product.category_id)) continue
    const list = productsByCategory.get(product.category_id) ?? []
    list.push(product.id)
    productsByCategory.set(product.category_id, list)
  }

  const categories: WholesaleCategory[] = Array.from(productsByCategory.entries()).map(([id, productIds]) => {
    const c = byId.get(id)!
    return { id, slug: c.slug, name: c.name, key: c.key, imageUrl: null, imageAlt: null, imageSource: null, productCount: productIds.length }
  })

  categories.sort((a, b) => {
    const aPriority = a.slug === WHOLESALE_PRIORITY_CATEGORY_SLUG ? 0 : 1
    const bPriority = b.slug === WHOLESALE_PRIORITY_CATEGORY_SLUG ? 0 : 1
    if (aPriority !== bPriority) return aPriority - bPriority
    return a.name.localeCompare(b.name, 'pt-BR')
  })

  if (options.withImages && categories.length > 0) {
    const covers = await loadCategoryCovers(admin, companyId, categories.map((c) => c.id))
    const missing = categories.filter((c) => !covers.has(c.id))

    // Sem capa configurada: foto de um produto da categoria (até 3 candidatos, em lote) — nunca um placeholder.
    const candidateIds = missing.flatMap((c) => (productsByCategory.get(c.id) ?? []).slice(0, 3))
    const imagesByProduct = candidateIds.length > 0 ? await loadImagesByProduct(companyId, candidateIds) : {}

    for (const c of categories) {
      const cover = covers.get(c.id)
      if (cover) { c.imageUrl = cover.url; c.imageAlt = cover.alt; c.imageSource = 'cover'; continue }
      for (const productId of (productsByCategory.get(c.id) ?? []).slice(0, 3)) {
        const image = imagesByProduct[productId]?.[0]
        if (image) { c.imageUrl = image.url; c.imageAlt = image.alt; c.imageSource = 'product'; break }
      }
    }
  }

  return categories
}

export interface RecommendationOptions {
  /** Produtos a excluir — todos os que já estão no carrinho (qualquer variação). */
  excludeProductIds: number[]
  /** Semente da sessão: define a "aleatoriedade" estável. */
  seed: string
  limit?: number
}

/**
 * Recomendações do carrinho — "Adicione também". Reaproveita `resolveVisibleProducts` (a MESMA regra
 * da vitrine: empresa, ativo, habilitado no atacado, preço e estoque) e ainda exige variação vendável,
 * mesmo quando a empresa exibe produtos esgotados na vitrine. Entre os elegíveis, a ordem vem da seed.
 */
export async function getWholesaleRecommendations(companyId: number, options: RecommendationOptions): Promise<WholesaleCatalogProduct[]> {
  const admin = createAdminClient()
  const settings = await getWholesaleSiteSettings(companyId)
  const limit = Math.min(RECOMMENDATION_MAX, Math.max(1, options.limit ?? RECOMMENDATION_MAX))
  const excluded = new Set(options.excludeProductIds)

  const visible = await resolveVisibleProducts(admin, companyId, settings, {})
  const eligible = visible.filter((v) => !excluded.has(v.product.id) && v.evaluated.some((e) => e.result.sellable))
  if (eligible.length === 0) return []

  const byId = new Map(eligible.map((v) => [v.product.id, v]))
  const picked = rankBySeed([...byId.keys()], options.seed).slice(0, limit).map((id) => byId.get(id)!)

  // Atributos e imagens só dos escolhidos (no máximo 6) — a lista inteira nunca é hidratada.
  const variationIds = picked.flatMap((p) => p.evaluated.map((e) => e.row.id))
  const [attrsByVariation, imagesByProduct] = await Promise.all([
    loadAttributesByVariation(admin as any, variationIds),
    loadImagesByProduct(companyId, picked.map((p) => p.product.id)),
  ])

  return picked.map(({ product, evaluated }) =>
    toCatalogProduct(product, evaluated, attrsByVariation, imagesByProduct[product.id] ?? [], settings.showStockQuantity),
  )
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
