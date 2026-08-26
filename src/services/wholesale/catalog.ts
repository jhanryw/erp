/**
 * Catálogo público do site de atacado — Fase 8.
 *
 * Fonte de verdade 100% do ERP existente — `products`/`product_variations`/
 * `stock_balances`/`media_usages`, NENHUMA tabela de catálogo nova. Nunca
 * devolve o objeto cru de `products`/`product_variations` (seção 43-44 do
 * pedido: DTO público seguro, sem custo/margem/NCM/CST/estoque exato/IDs
 * administrativos) — só os campos explicitamente listados como seguros.
 *
 * Preço: `resolveSalePrice({ saleType: 'wholesale', ... })` — a MESMA
 * função pura já usada pelo PDV (Fase 3), nunca uma segunda lógica de
 * preço. Produto/variação sem preço de atacado nunca aparece como
 * comprável (nunca cai pro preço de varejo).
 *
 * Estoque: soma de `stock_balances` em TODAS as `stock_locations` ativas
 * da empresa — mesmo escopo que `p_stock_mode='online_priority'` vai
 * debitar de verdade no checkout (ver checkout.ts) — nunca só o Estoque
 * Loja principal (isso seria `main_store`, usado pelo PDV físico, escopo
 * errado pra um canal online). Exposto só como `available`/`lowStock`
 * (booleanos) — nunca a quantidade exata (seção 44 do pedido).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { resolveSalePrice } from '@/lib/pricing/resolveSalePrice'
import { getWholesaleSiteSettings } from './settings'

const LOW_STOCK_THRESHOLD = 3

/**
 * Slug estável da categoria que deve aparecer primeiro na home do
 * catálogo (seção 13 do pedido) — nunca um `category_id` numérico (que
 * varia por ambiente/empresa). Se a empresa não tiver uma categoria com
 * este slug, ou ela não tiver produto comprável, o catálogo simplesmente
 * segue a ordem normal (alfabética) — nunca quebra nem redireciona.
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
}

export interface WholesaleCatalogProduct {
  productId: number
  name: string
  brand: string | null
  category: string | null
  /** Slug estável da categoria — usado pra ordenação de prioridade (Calcinhas) e link de navegação, nunca exibido cru. */
  categorySlug: string | null
  images: { url: string; alt: string | null }[]
  variations: WholesaleCatalogVariation[]
  /** Menor preço entre as variações compráveis — pra exibição em listagem ("a partir de"). `null` quando nenhuma variação tem preço de atacado. */
  priceFrom: number | null
  /** false quando NENHUMA variação está disponível para compra (sem preço de atacado, ou sem estoque em todas). */
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

async function loadStockByVariation(admin: ReturnType<typeof createAdminClient>, companyId: number, variationIds: number[]): Promise<Record<number, number>> {
  if (variationIds.length === 0) return {}
  const { data } = await (admin as any)
    .from('stock_balances')
    .select('product_variation_id, quantity, stock_locations!inner(company_id, active)')
    .in('product_variation_id', variationIds)
    .eq('stock_locations.company_id', companyId)
    .eq('stock_locations.active', true) as { data: { product_variation_id: number; quantity: number }[] | null }

  const byVariation: Record<number, number> = {}
  for (const row of data ?? []) {
    byVariation[row.product_variation_id] = (byVariation[row.product_variation_id] ?? 0) + Number(row.quantity ?? 0)
  }
  return byVariation
}

/** Resolve preço + disponibilidade de uma variação — mesma regra usada tanto na listagem quanto no detalhe do produto. */
function buildCatalogVariation(
  v: { id: number; sku_variation: string; wholesale_price_override: number | null },
  wholesalePrice: number | null,
  stockByVariation: Record<number, number>,
  attrsByVariation: Record<number, { type: string; value: string }[]>,
  showStockQuantity: boolean,
): WholesaleCatalogVariation {
  const resolved = resolveSalePrice({
    saleType: 'wholesale',
    basePrice: 0, // nunca usado — saleType='wholesale' nunca cai em base_price/price_override (retail)
    priceOverride: null,
    wholesalePrice,
    wholesalePriceOverride: v.wholesale_price_override,
  })
  const stock = stockByVariation[v.id] ?? 0
  return {
    variationId: v.id,
    sku: v.sku_variation,
    attributes: attrsByVariation[v.id] ?? [],
    price: resolved.price ?? 0,
    available: resolved.price != null && stock > 0,
    lowStock: resolved.price != null && stock > 0 && stock <= LOW_STOCK_THRESHOLD,
    ...(showStockQuantity ? { stockQuantity: stock } : {}),
  }
}

export async function getWholesaleCatalogPage(companyId: number, filters: CatalogFilters = {}): Promise<CatalogPage> {
  const admin = createAdminClient()
  const settings = await getWholesaleSiteSettings(companyId)
  const page = Math.max(1, filters.page ?? 1)
  const pageSize = Math.min(60, Math.max(1, filters.pageSize ?? 24))
  const offset = (page - 1) * pageSize

  let query = (admin as any)
    .from('products')
    .select('id, name, wholesale_price, brands:brand_id(name), categories:category_id(name, slug)')
    .eq('company_id', companyId)
    .eq('active', true)

  if (filters.search) query = query.ilike('name', `%${filters.search}%`)
  if (filters.categorySlug) query = query.eq('categories.slug', filters.categorySlug)

  // Sem `.range()` aqui de propósito: a prioridade de Calcinhas (seção 13
  // do pedido) precisa reordenar o conjunto INTEIRO antes de paginar, não
  // só a página atual — mesma decisão já tomada em `listWholesaleCategories`
  // (dataset de um catálogo de atacado é pequeno, nunca milhares de
  // produtos). `.limit(2000)` é só uma rede de segurança, não o mecanismo
  // de paginação real (esse é o `.slice()` mais abaixo).
  const { data: productRows } = await query
    .order('name', { ascending: true })
    .limit(2000) as { data: any[] | null }

  const productIds = (productRows ?? []).map((p) => p.id)
  if (productIds.length === 0) return { products: [], total: 0, page, pageSize }

  const { data: variationRows } = await (admin as any)
    .from('product_variations')
    .select('id, product_id, sku_variation, price_override, wholesale_price_override, active')
    .in('product_id', productIds)
    .eq('active', true) as { data: any[] | null }

  const variations = (variationRows ?? []) as { id: number; product_id: number; sku_variation: string; price_override: number | null; wholesale_price_override: number | null; active: boolean }[]
  const variationIds = variations.map((v) => v.id)

  const [{ data: attrRows }, stockByVariation, ...mediaResults] = await Promise.all([
    variationIds.length
      ? (admin as any)
          .from('product_variation_attributes')
          .select('product_variation_id, variation_types:variation_type_id(name), variation_values:variation_value_id(value)')
          .in('product_variation_id', variationIds)
      : Promise.resolve({ data: [] }),
    loadStockByVariation(admin, companyId, variationIds),
    ...productIds.map((pid) => listMediaForProduct(admin, companyId, pid)),
  ])

  const attrsByVariation: Record<number, { type: string; value: string }[]> = {}
  for (const a of (attrRows ?? []) as any[]) {
    const typeName = Array.isArray(a.variation_types) ? a.variation_types[0]?.name : a.variation_types?.name
    const value = Array.isArray(a.variation_values) ? a.variation_values[0]?.value : a.variation_values?.value
    if (!value) continue
    const list = attrsByVariation[a.product_variation_id] ?? []
    list.push({ type: typeName ?? '', value })
    attrsByVariation[a.product_variation_id] = list
  }

  const mediaByProduct: Record<number, { url: string; alt: string | null }[]> = {}
  productIds.forEach((pid, i) => { mediaByProduct[pid] = mediaResults[i] })

  const allProducts: WholesaleCatalogProduct[] = (productRows ?? []).map((p) => {
    const brand = Array.isArray(p.brands) ? p.brands[0] : p.brands
    const category = Array.isArray(p.categories) ? p.categories[0] : p.categories
    const productVariations = variations.filter((v) => v.product_id === p.id)

    const catalogVariations: WholesaleCatalogVariation[] = productVariations.map((v) =>
      buildCatalogVariation(v, p.wholesale_price, stockByVariation, attrsByVariation, settings.showStockQuantity),
    )

    const purchasableVariations = catalogVariations.filter((v) => v.available)
    const priceFrom = purchasableVariations.length > 0
      ? Math.min(...purchasableVariations.map((v) => v.price))
      : null

    return {
      productId: p.id,
      name: p.name,
      brand: brand?.name ?? null,
      category: category?.name ?? null,
      categorySlug: category?.slug ?? null,
      images: mediaByProduct[p.id] ?? [],
      variations: catalogVariations,
      priceFrom,
      purchasable: purchasableVariations.length > 0,
    }
  })

  // Por padrão a vitrine não mostra produto sem nenhuma variação compravel
  // (seção 7 do pedido) — configurável via wholesale_site_settings.show_out_of_stock.
  const visible = settings.showOutOfStock ? allProducts : allProducts.filter((p) => p.purchasable)

  // Calcinhas primeiro (seção 13 do pedido) — só na home "sem filtro"; uma
  // busca ou um filtro de categoria explícito já é a intenção do cliente,
  // não faz sentido reordenar por cima disso. Sort estável: dentro de cada
  // grupo (prioridade / resto) a ordem alfabética da query é preservada.
  const ordered = (filters.search || filters.categorySlug)
    ? visible
    : [...visible].sort((a, b) => {
        const aPriority = a.categorySlug === WHOLESALE_PRIORITY_CATEGORY_SLUG ? 0 : 1
        const bPriority = b.categorySlug === WHOLESALE_PRIORITY_CATEGORY_SLUG ? 0 : 1
        return aPriority - bPriority
      })

  const total = ordered.length
  const products = ordered.slice(offset, offset + pageSize)

  return { products, total, page, pageSize }
}

/**
 * Categorias com pelo menos 1 produto disponível para atacado — usado pela
 * sidebar/drawer de categorias do catálogo (seção 5 do pedido: nunca
 * mostrar categoria vazia). Reaproveita `categories` já existente —
 * nenhuma tabela nova. Uma única leitura de todos os produtos ativos da
 * empresa (dataset pequeno, ver auditoria) — nunca N+1 por categoria.
 */
export interface WholesaleCategory {
  slug: string
  name: string
}

export async function listWholesaleCategories(companyId: number): Promise<WholesaleCategory[]> {
  const admin = createAdminClient()
  const settings = await getWholesaleSiteSettings(companyId)

  const { data: productRows } = await (admin as any)
    .from('products')
    .select('id, wholesale_price, categories:category_id(name, slug)')
    .eq('company_id', companyId)
    .eq('active', true) as { data: any[] | null }

  const productIds = (productRows ?? []).map((p) => p.id)
  if (productIds.length === 0) return []

  const { data: variationRows } = await (admin as any)
    .from('product_variations')
    .select('id, product_id, wholesale_price_override')
    .in('product_id', productIds)
    .eq('active', true) as { data: { id: number; product_id: number; wholesale_price_override: number | null }[] | null }

  const variations = variationRows ?? []
  const stockByVariation = await loadStockByVariation(admin, companyId, variations.map((v) => v.id))

  const categoriesWithProduct = new Map<string, WholesaleCategory>()

  for (const p of productRows ?? []) {
    const category = Array.isArray(p.categories) ? p.categories[0] : p.categories
    if (!category?.slug) continue
    if (categoriesWithProduct.has(category.slug)) continue

    const hasPurchasableVariation = variations
      .filter((v) => v.product_id === p.id)
      .some((v) => {
        const resolved = resolveSalePrice({
          saleType: 'wholesale', basePrice: 0, priceOverride: null,
          wholesalePrice: p.wholesale_price, wholesalePriceOverride: v.wholesale_price_override,
        })
        return resolved.price != null && (settings.showOutOfStock || (stockByVariation[v.id] ?? 0) > 0)
      })

    if (hasPurchasableVariation) categoriesWithProduct.set(category.slug, { slug: category.slug, name: category.name })
  }

  // Calcinhas também tem prioridade na navegação (seção 13 do pedido) —
  // mesmo critério de ordenação usado em `getWholesaleCatalogPage`.
  return Array.from(categoriesWithProduct.values()).sort((a, b) => {
    const aPriority = a.slug === WHOLESALE_PRIORITY_CATEGORY_SLUG ? 0 : 1
    const bPriority = b.slug === WHOLESALE_PRIORITY_CATEGORY_SLUG ? 0 : 1
    if (aPriority !== bPriority) return aPriority - bPriority
    return a.name.localeCompare(b.name, 'pt-BR')
  })
}

async function listMediaForProduct(admin: ReturnType<typeof createAdminClient>, companyId: number, productId: number): Promise<{ url: string; alt: string | null }[]> {
  // Reaproveita a mesma listagem já usada pela tela administrativa de
  // produto (Media Hub) — nunca um segundo caminho de upload/consulta de
  // imagem só para o site de atacado (seção 11 do pedido).
  const { listMediaByEntity } = await import('@/services/media.service')
  const result = await listMediaByEntity('product', String(productId), companyId)
  if (!result.ok) return []
  return result.data
    .filter((m) => m.role === 'primary' || m.role === 'gallery')
    .map((m) => ({ url: m.url, alt: m.alt_text }))
}

export async function getWholesaleProductDetail(companyId: number, productId: number): Promise<WholesaleCatalogProduct | null> {
  const admin = createAdminClient()
  const settings = await getWholesaleSiteSettings(companyId)
  const { data: p } = await (admin as any)
    .from('products')
    .select('id, name, wholesale_price, brands:brand_id(name), categories:category_id(name, slug)')
    .eq('company_id', companyId)
    .eq('id', productId)
    .eq('active', true)
    .maybeSingle() as { data: any | null }

  if (!p) return null

  const { data: variationRows } = await (admin as any)
    .from('product_variations')
    .select('id, product_id, sku_variation, price_override, wholesale_price_override, active')
    .eq('product_id', productId)
    .eq('active', true) as { data: any[] | null }

  const variations = variationRows ?? []
  const variationIds = variations.map((v: any) => v.id)

  const [{ data: attrRows }, stockByVariation, media] = await Promise.all([
    variationIds.length
      ? (admin as any)
          .from('product_variation_attributes')
          .select('product_variation_id, variation_types:variation_type_id(name), variation_values:variation_value_id(value)')
          .in('product_variation_id', variationIds)
      : Promise.resolve({ data: [] }),
    loadStockByVariation(admin, companyId, variationIds),
    listMediaForProduct(admin, companyId, productId),
  ])

  const attrsByVariation: Record<number, { type: string; value: string }[]> = {}
  for (const a of (attrRows ?? []) as any[]) {
    const typeName = Array.isArray(a.variation_types) ? a.variation_types[0]?.name : a.variation_types?.name
    const value = Array.isArray(a.variation_values) ? a.variation_values[0]?.value : a.variation_values?.value
    if (!value) continue
    const list = attrsByVariation[a.product_variation_id] ?? []
    list.push({ type: typeName ?? '', value })
    attrsByVariation[a.product_variation_id] = list
  }

  const catalogVariations: WholesaleCatalogVariation[] = variations.map((v: any) =>
    buildCatalogVariation(v, p.wholesale_price, stockByVariation, attrsByVariation, settings.showStockQuantity),
  )

  const purchasableVariations = catalogVariations.filter((v) => v.available)
  const brand = Array.isArray(p.brands) ? p.brands[0] : p.brands
  const category = Array.isArray(p.categories) ? p.categories[0] : p.categories

  return {
    productId: p.id,
    name: p.name,
    brand: brand?.name ?? null,
    category: category?.name ?? null,
    categorySlug: category?.slug ?? null,
    images: media,
    variations: catalogVariations,
    priceFrom: purchasableVariations.length > 0 ? Math.min(...purchasableVariations.map((v) => v.price)) : null,
    purchasable: purchasableVariations.length > 0,
  }
}
