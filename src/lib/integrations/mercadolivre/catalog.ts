/**
 * Categorias e atributos do Mercado Livre — leitura via API oficial, nunca
 * catálogo copiado para o banco. Cache em memória com TTL (dados públicos do
 * ML, iguais para todas as empresas).
 *
 * Endpoints (doc "Categorização de produtos" 29/12/2025 e "Atributos" 08/06/2026):
 *   GET  /sites/{site}/domain_discovery/search?q=&limit=   preditor de categoria
 *   GET  /categories/{id}                                   detalhe + settings
 *   GET  /categories/{id}/attributes                        atributos + tags
 *   POST /categories/{id}/attributes/conditional            conditional_required
 *
 * Nada aqui conhece lingerie, kit ou produto do Qarvon: só normaliza o que o
 * ML devolve para o formulário dinâmico e para a montagem do anúncio.
 */

import { mercadoLivreRequest, type MercadoLivreRequestDeps } from './client'

export interface CategorySuggestion {
  category_id: string
  category_name: string
  domain_id: string | null
  domain_name: string | null
  /** Atributos que o preditor já inferiu (ex.: BRAND), usados como sugestão. */
  suggested_attributes: Array<{ id: string; value_id: string | null; value_name: string | null }>
}

export interface CategoryDetails {
  id: string
  name: string
  path: Array<{ id: string; name: string }>
  listing_allowed: boolean
  status: string | null
  max_title_length: number
  max_pictures_per_item: number
  max_description_length: number | null
  currencies: string[]
  item_conditions: string[]
  buying_modes: string[]
  minimum_price: number | null
  children_count: number
}

export interface AttributeDefinition {
  id: string
  name: string
  value_type: string
  values: Array<{ id: string; name: string }>
  required: boolean
  conditional_required: boolean
  new_required: boolean
  /** Varia por variação (CHILD_PK / allow_variations / variation_attribute). */
  varies_by_variation: boolean
  hidden: boolean
  read_only: boolean
  fixed: boolean
  multivalued: boolean
  max_length: number | null
  allowed_units: string[]
  default_unit: string | null
  group: string | null
  hierarchy: string | null
}

type Cached<T> = { value: T; expiresAt: number }
const CACHE_TTL_MS = 60 * 60 * 1000
const cache = new Map<string, Cached<unknown>>()

/** Só para testes. */
export function clearMercadoLivreCatalogCache(): void {
  cache.clear()
}

async function cached<T>(key: string, load: () => Promise<T>, now = Date.now()): Promise<T> {
  const hit = cache.get(key) as Cached<T> | undefined
  if (hit && hit.expiresAt > now) return hit.value
  const value = await load()
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS })
  return value
}

interface Ctx {
  integrationId: number
  companyId: number
  deps?: MercadoLivreRequestDeps
}

export async function searchCategories(ctx: Ctx, siteId: string, query: string, limit = 5): Promise<CategorySuggestion[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const res = await mercadoLivreRequest<Array<Record<string, unknown>>>({
    integrationId: ctx.integrationId, companyId: ctx.companyId, method: 'GET',
    path: `/sites/${encodeURIComponent(siteId)}/domain_discovery/search`,
    query: { q, limit: Math.min(Math.max(limit, 1), 8) },
    deps: ctx.deps,
  })
  return (Array.isArray(res.data) ? res.data : []).map((r) => ({
    category_id: String(r.category_id ?? ''),
    category_name: String(r.category_name ?? ''),
    domain_id: (r.domain_id as string) ?? null,
    domain_name: (r.domain_name as string) ?? null,
    suggested_attributes: Array.isArray(r.attributes)
      ? (r.attributes as Array<Record<string, unknown>>).map((a) => ({
          id: String(a.id), value_id: (a.value_id as string) ?? null, value_name: (a.value_name as string) ?? null,
        }))
      : [],
  })).filter((s) => s.category_id)
}

export function normalizeCategory(raw: Record<string, unknown>): CategoryDetails {
  const settings = (raw.settings ?? {}) as Record<string, unknown>
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    path: Array.isArray(raw.path_from_root) ? (raw.path_from_root as Array<{ id: string; name: string }>).map((p) => ({ id: p.id, name: p.name })) : [],
    listing_allowed: settings.listing_allowed !== false,
    status: (settings.status as string) ?? null,
    max_title_length: Number(settings.max_title_length ?? 60),
    max_pictures_per_item: Number(settings.max_pictures_per_item ?? 10),
    max_description_length: settings.max_description_length != null ? Number(settings.max_description_length) : null,
    currencies: (settings.currencies as string[]) ?? [],
    item_conditions: (settings.item_conditions as string[]) ?? [],
    buying_modes: (settings.buying_modes as string[]) ?? [],
    minimum_price: settings.minimum_price != null ? Number(settings.minimum_price) : null,
    children_count: Array.isArray(raw.children_categories) ? (raw.children_categories as unknown[]).length : 0,
  }
}

export async function getCategoryDetails(ctx: Ctx, categoryId: string): Promise<CategoryDetails> {
  return cached(`category:${categoryId}`, async () => {
    const res = await mercadoLivreRequest<Record<string, unknown>>({
      integrationId: ctx.integrationId, companyId: ctx.companyId, method: 'GET',
      path: `/categories/${encodeURIComponent(categoryId)}`, deps: ctx.deps,
    })
    return normalizeCategory(res.data)
  })
}

/** Tags vêm como objeto {tag: true} em /attributes e como array em technical_specs — aceita os dois. */
function tagSet(tags: unknown): Set<string> {
  if (Array.isArray(tags)) return new Set(tags.map(String))
  if (tags && typeof tags === 'object') {
    return new Set(Object.entries(tags as Record<string, unknown>).filter(([, v]) => v === true).map(([k]) => k))
  }
  return new Set()
}

export function normalizeAttribute(raw: Record<string, unknown>): AttributeDefinition {
  const tags = tagSet(raw.tags)
  const hierarchy = (raw.hierarchy as string) ?? null
  return {
    id: String(raw.id),
    name: String(raw.name ?? raw.id),
    value_type: String(raw.value_type ?? 'string'),
    values: Array.isArray(raw.values) ? (raw.values as Array<{ id: string; name: string }>).map((v) => ({ id: String(v.id), name: String(v.name) })) : [],
    required: tags.has('required'),
    conditional_required: tags.has('conditional_required'),
    new_required: tags.has('new_required'),
    varies_by_variation: tags.has('allow_variations') || tags.has('variation_attribute') || hierarchy === 'CHILD_PK',
    hidden: tags.has('hidden'),
    read_only: tags.has('read_only'),
    fixed: tags.has('fixed') || tags.has('inferred'),
    multivalued: tags.has('multivalued'),
    max_length: raw.value_max_length != null ? Number(raw.value_max_length) : null,
    allowed_units: Array.isArray(raw.allowed_units) ? (raw.allowed_units as Array<{ id: string }>).map((u) => String(u.id)) : [],
    default_unit: (raw.default_unit as string) ?? null,
    group: (raw.attribute_group_name as string) ?? null,
    hierarchy,
  }
}

/**
 * Atributos PREENCHÍVEIS pelo vendedor: sem read_only (ML não aceita) e sem
 * fixed/inferred (ML preenche). SELLER_SKU nunca é editável no formulário:
 * vem sempre do SKU vendável do Qarvon.
 */
export async function getCategoryAttributes(ctx: Ctx, categoryId: string): Promise<AttributeDefinition[]> {
  return cached(`attributes:${categoryId}`, async () => {
    const res = await mercadoLivreRequest<Array<Record<string, unknown>>>({
      integrationId: ctx.integrationId, companyId: ctx.companyId, method: 'GET',
      path: `/categories/${encodeURIComponent(categoryId)}/attributes`, deps: ctx.deps,
    })
    return (Array.isArray(res.data) ? res.data : [])
      .map(normalizeAttribute)
      .filter((a) => !a.read_only && !a.fixed && a.id !== 'SELLER_SKU')
  })
}

/**
 * conditional_required: o ML decide com base no item completo (doc
 * "Atributos"). Devolve os ids que passaram a ser obrigatórios.
 */
export async function checkConditionalAttributes(
  ctx: Ctx,
  categoryId: string,
  item: { attributes: Array<{ id: string; value_id?: string | null; value_name?: string | null }> },
): Promise<string[]> {
  const res = await mercadoLivreRequest<unknown>({
    integrationId: ctx.integrationId, companyId: ctx.companyId, method: 'POST',
    path: `/categories/${encodeURIComponent(categoryId)}/attributes/conditional`,
    body: { category_id: categoryId, attributes: item.attributes },
    deps: ctx.deps,
  })
  const list = Array.isArray(res.data)
    ? res.data
    : Array.isArray((res.data as { attributes?: unknown[] })?.attributes) ? (res.data as { attributes: unknown[] }).attributes : []
  return (list as Array<Record<string, unknown>>)
    .map(normalizeAttribute)
    .filter((a) => a.required || a.conditional_required)
    .map((a) => a.id)
}

/** Obrigatórios que ainda estão vazios (inclui os condicionais já resolvidos). */
export function missingRequiredAttributes(
  definitions: AttributeDefinition[],
  values: Array<{ id: string; value_id?: string | null; value_name?: string | null }>,
  extraRequiredIds: string[] = [],
): string[] {
  const filled = new Set(values.filter((v) => (v.value_id ?? '').toString().trim() || (v.value_name ?? '').toString().trim()).map((v) => v.id))
  const required = new Set([...definitions.filter((d) => d.required || d.new_required).map((d) => d.id), ...extraRequiredIds])
  // GTIN condicional pode ser substituído por EMPTY_GTIN_REASON (doc "Identificadores de produtos").
  if (required.has('GTIN') && filled.has('EMPTY_GTIN_REASON')) required.delete('GTIN')
  return [...required].filter((id) => id !== 'SELLER_SKU' && !filled.has(id)).sort()
}
