/**
 * Catálogo da Shopee (somente leitura) para UMA loja conectada.
 *
 * Endpoints (referência oficial v2, conferida em 28/09/2026 no navegador):
 *   GET /api/v2/product/get_category        → response.category_list[
 *         {category_id, parent_category_id, original_category_name,
 *          display_category_name, has_children}]
 *   GET /api/v2/product/get_attribute_tree  (category_id_list, language)
 *         → response.list[{category_id, attribute_tree[{attribute_id,
 *          mandatory, name, attribute_value_list[{value_id,name,value_unit,
 *          child_attribute_list}], attribute_info{input_type,
 *          input_validation_type, format_type, attribute_unit_list,
 *          max_value_count}, multi_lang}]}]
 *   GET /api/v2/product/get_brand_list      (offset, page_size≤100,
 *          category_id, status=1) → response{brand_list[{brand_id,
 *          original_brand_name, display_brand_name}], has_next_page,
 *          next_offset, is_mandatory, input_type}
 *   GET /api/v2/logistics/get_channel_list  → response.logistics_channel_list[
 *         {logistics_channel_id, logistics_channel_name, enabled, fee_type,
 *          weight_limit{item_max_weight,item_min_weight},
 *          item_max_dimension{height,width,length,unit,dimension_sum}}]
 *
 * Nada é hardcoded (categorias, atributos, marcas, canais logísticos) e nada
 * é persistido: sem cache nesta fase (o projeto não tem um helper de cache
 * seguro reutilizável). IDs oficiais da Shopee são preservados.
 */

import { SHOPEE_PATHS } from './config'
import { ShopeeError } from './errors'
import { shopeeResponseBody, shopeeShopRequest, type ShopeeShopContext } from './client'

/** Idioma do Brasil aceito por get_category ("pt-br") e get_attribute_tree ("pt-BR"). */
const CATEGORY_LANGUAGE = 'pt-br'
const ATTRIBUTE_LANGUAGE = 'pt-BR'

// ─── Categorias ──────────────────────────────────────────────────────────────

export interface ShopeeCategory {
  category_id: number
  parent_category_id: number | null
  name: string
  original_name: string
  has_children: boolean
  /** Folha = sem filhos ativos (só folha aceita add_item). */
  is_leaf: boolean
}

function toInt(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isInteger(n) ? n : null
}

export function parseCategoryList(data: unknown): ShopeeCategory[] {
  const r = shopeeResponseBody(data, SHOPEE_PATHS.getCategory)
  if (!Array.isArray(r.category_list)) throw new ShopeeError('invalid_response', 'get_category sem category_list.')
  const out: ShopeeCategory[] = []
  for (const raw of r.category_list as Array<Record<string, unknown>>) {
    const id = toInt(raw?.category_id)
    if (id == null || id <= 0 || typeof raw.has_children !== 'boolean') {
      throw new ShopeeError('invalid_response', 'get_category devolveu categoria incompleta.')
    }
    const parent = toInt(raw.parent_category_id)
    const original = String(raw.original_category_name ?? '').trim()
    out.push({
      category_id: id,
      parent_category_id: parent && parent > 0 ? parent : null,
      name: String(raw.display_category_name ?? '').trim() || original,
      original_name: original,
      has_children: raw.has_children,
      is_leaf: !raw.has_children,
    })
  }
  return out
}

export async function getCategories(ctx: ShopeeShopContext): Promise<ShopeeCategory[]> {
  const res = await shopeeShopRequest(ctx, { method: 'GET', path: SHOPEE_PATHS.getCategory, query: { language: CATEGORY_LANGUAGE } })
  return parseCategoryList(res.data)
}

/** Caminho raiz → categoria (nomes), a partir da lista plana. */
export function categoryPath(list: ShopeeCategory[], categoryId: number): ShopeeCategory[] {
  const byId = new Map(list.map((c) => [c.category_id, c]))
  const path: ShopeeCategory[] = []
  let cur = byId.get(categoryId)
  const seen = new Set<number>()
  while (cur && !seen.has(cur.category_id)) {
    seen.add(cur.category_id)
    path.unshift(cur)
    cur = cur.parent_category_id ? byId.get(cur.parent_category_id) : undefined
  }
  return path
}

export interface ShopeeCategoryDetails extends ShopeeCategory {
  path: Array<{ category_id: number; name: string }>
}

/** Categoria existente nesta loja, com hierarquia. Inexistente → not_found. */
export function findCategory(list: ShopeeCategory[], categoryId: number): ShopeeCategoryDetails {
  const cat = list.find((c) => c.category_id === categoryId)
  if (!cat) throw new ShopeeError('not_found', `Categoria Shopee ${categoryId} não existe para esta loja.`)
  return { ...cat, path: categoryPath(list, categoryId).map((c) => ({ category_id: c.category_id, name: c.name })) }
}

// ─── Atributos ───────────────────────────────────────────────────────────────

/** attribute_info.input_type (doc): 1 SINGLE_DROP_DOWN, 2 SINGLE_COMBO_BOX, 3 FREE_TEXT_FILED, 4 MULTI_DROP_DOWN, 5 MULTI_COMBO_BOX. */
export type ShopeeAttributeInputType = 'single_select' | 'single_combo' | 'free_text' | 'multi_select' | 'multi_combo' | 'unknown'
/** attribute_info.input_validation_type: 0 sem validação, 1 int, 2 string, 3 float, 4 data. */
export type ShopeeAttributeValidation = 'none' | 'int' | 'string' | 'float' | 'date' | 'unknown'

const INPUT_TYPES: Record<number, ShopeeAttributeInputType> = { 1: 'single_select', 2: 'single_combo', 3: 'free_text', 4: 'multi_select', 5: 'multi_combo' }
const VALIDATIONS: Record<number, ShopeeAttributeValidation> = { 0: 'none', 1: 'int', 2: 'string', 3: 'float', 4: 'date' }

export interface ShopeeAttributeValueOption {
  value_id: number
  name: string
  value_unit: string | null
}

export interface ShopeeAttributeDefinition {
  attribute_id: number
  name: string
  mandatory: boolean
  input_type: ShopeeAttributeInputType
  /** Código cru (preservado para diagnóstico). */
  input_type_code: number | null
  validation: ShopeeAttributeValidation
  /** true = FORMAT_QUANTITATIVE_WITH_UNIT (valor exige unidade de attribute_unit_list). */
  quantitative: boolean
  units: string[]
  max_value_count: number | null
  /** Seleção: só estes value_id; combo: estes ou valor livre (value_id=0). */
  values: ShopeeAttributeValueOption[]
  /** Valores pesquisáveis via search_attribute_value_list (não listados aqui). */
  support_search_value: boolean
  /** Aceita valor digitado (value_id=0 + original_value_name). */
  accepts_custom_value: boolean
  multiple: boolean
}

export function parseAttributeTree(data: unknown, categoryId: number): ShopeeAttributeDefinition[] {
  const r = shopeeResponseBody(data, SHOPEE_PATHS.getAttributeTree)
  if (!Array.isArray(r.list)) throw new ShopeeError('invalid_response', 'get_attribute_tree sem list.')
  const entry = (r.list as Array<Record<string, unknown>>).find((x) => toInt(x?.category_id) === categoryId)
  if (!entry) throw new ShopeeError('invalid_response', `get_attribute_tree não devolveu a categoria ${categoryId}.`)
  const tree = Array.isArray(entry.attribute_tree) ? (entry.attribute_tree as Array<Record<string, unknown>>) : []
  return tree.map((a) => {
    const id = toInt(a?.attribute_id)
    if (id == null || id <= 0 || typeof a.mandatory !== 'boolean') {
      throw new ShopeeError('invalid_response', 'get_attribute_tree devolveu atributo incompleto.')
    }
    const info = (a.attribute_info ?? {}) as Record<string, unknown>
    const code = toInt(info.input_type)
    const inputType = code != null ? (INPUT_TYPES[code] ?? 'unknown') : 'unknown'
    const values = (Array.isArray(a.attribute_value_list) ? a.attribute_value_list as Array<Record<string, unknown>> : [])
      .map((v) => ({ value_id: toInt(v?.value_id) ?? 0, name: String(v?.name ?? '').trim(), value_unit: v?.value_unit ? String(v.value_unit) : null }))
      .filter((v) => v.value_id > 0)
    const validationCode = toInt(info.input_validation_type)
    return {
      attribute_id: id,
      name: String(a.name ?? '').trim(),
      mandatory: a.mandatory,
      input_type: inputType,
      input_type_code: code,
      validation: validationCode != null ? (VALIDATIONS[validationCode] ?? 'unknown') : 'unknown',
      quantitative: toInt(info.format_type) === 2,
      units: Array.isArray(info.attribute_unit_list) ? (info.attribute_unit_list as unknown[]).map(String) : [],
      max_value_count: toInt(info.max_value_count),
      values,
      support_search_value: a.support_search_value === true,
      accepts_custom_value: inputType === 'free_text' || inputType === 'single_combo' || inputType === 'multi_combo',
      multiple: inputType === 'multi_select' || inputType === 'multi_combo',
    }
  })
}

export async function getCategoryAttributes(ctx: ShopeeShopContext, categoryId: number): Promise<ShopeeAttributeDefinition[]> {
  // A tabela da doc nomeia o parâmetro `category_id_list` (int[], máx. 20);
  // com 1 categoria o valor enviado é o mesmo em qualquer codificação de lista.
  const res = await shopeeShopRequest(ctx, {
    method: 'GET', path: SHOPEE_PATHS.getAttributeTree, query: { category_id_list: categoryId, language: ATTRIBUTE_LANGUAGE },
  })
  return parseAttributeTree(res.data, categoryId)
}

// ─── Marcas ──────────────────────────────────────────────────────────────────

export interface ShopeeBrand {
  brand_id: number
  original_brand_name: string
  display_brand_name: string
}

export interface ShopeeBrandInfo {
  is_mandatory: boolean
  input_type: string | null
  brands: ShopeeBrand[]
  /**
   * Entrada "No Brand" DEVOLVIDA pela própria API para a categoria (nome
   * literal "No Brand"/"NoBrand", sem distinção de caixa). null = a API não
   * ofereceu "sem marca" — o Qarvon não inventa brand_id=0.
   */
  no_brand_option: ShopeeBrand | null
  /** A paginação foi interrompida no limite de páginas (lista possivelmente parcial). */
  truncated: boolean
}

const BRAND_PAGE_SIZE = 100
const MAX_BRAND_PAGES = 20

const NO_BRAND_RE = /^no\s*brand$/i

export async function getBrandList(ctx: ShopeeShopContext, categoryId: number): Promise<ShopeeBrandInfo> {
  const brands: ShopeeBrand[] = []
  let offset = 0
  let isMandatory: boolean | null = null
  let inputType: string | null = null
  let truncated = false
  for (let page = 0; ; page++) {
    if (page >= MAX_BRAND_PAGES) { truncated = true; break }
    const res = await shopeeShopRequest(ctx, {
      method: 'GET', path: SHOPEE_PATHS.getBrandList,
      query: { offset, page_size: BRAND_PAGE_SIZE, category_id: categoryId, status: 1, language: CATEGORY_LANGUAGE },
    })
    const r = shopeeResponseBody(res.data, SHOPEE_PATHS.getBrandList)
    if (typeof r.is_mandatory !== 'boolean') throw new ShopeeError('invalid_response', 'get_brand_list sem is_mandatory.')
    isMandatory = r.is_mandatory
    inputType = typeof r.input_type === 'string' ? r.input_type : inputType
    for (const b of (Array.isArray(r.brand_list) ? r.brand_list as Array<Record<string, unknown>> : [])) {
      const id = toInt(b?.brand_id)
      if (id == null || id < 0) continue
      const original = String(b.original_brand_name ?? '').trim()
      brands.push({ brand_id: id, original_brand_name: original, display_brand_name: String(b.display_brand_name ?? '').trim() || original })
    }
    const next = toInt(r.next_offset)
    if (r.has_next_page !== true || next == null || next <= offset) break
    offset = next
  }
  return {
    is_mandatory: isMandatory ?? false,
    input_type: inputType,
    brands,
    no_brand_option: brands.find((b) => NO_BRAND_RE.test(b.original_brand_name) || NO_BRAND_RE.test(b.display_brand_name)) ?? null,
    truncated,
  }
}

// ─── Logística (mínimo para add_item.logistic_info) ──────────────────────────

export interface ShopeeLogisticsChannel {
  logistics_channel_id: number
  name: string
  enabled: boolean
  fee_type: string | null
  /** kg; null = sem limite informado. */
  min_weight: number | null
  max_weight: number | null
  max_dimension: { height: number | null; width: number | null; length: number | null; unit: string | null } | null
}

function toNum(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
}

export function parseChannelList(data: unknown): ShopeeLogisticsChannel[] {
  const r = shopeeResponseBody(data, SHOPEE_PATHS.getChannelList)
  if (!Array.isArray(r.logistics_channel_list)) throw new ShopeeError('invalid_response', 'get_channel_list sem logistics_channel_list.')
  return (r.logistics_channel_list as Array<Record<string, unknown>>).flatMap((c) => {
    const id = toInt(c?.logistics_channel_id)
    if (id == null || id <= 0) return []
    const wl = (c.weight_limit ?? {}) as Record<string, unknown>
    const dim = c.item_max_dimension as Record<string, unknown> | undefined
    return [{
      logistics_channel_id: id,
      name: String(c.logistics_channel_name ?? '').trim(),
      enabled: c.enabled === true,
      fee_type: typeof c.fee_type === 'string' ? c.fee_type : null,
      min_weight: toNum(wl.item_min_weight),
      max_weight: toNum(wl.item_max_weight),
      max_dimension: dim ? { height: toNum(dim.height), width: toNum(dim.width), length: toNum(dim.length), unit: dim.unit ? String(dim.unit) : null } : null,
    }]
  })
}

export async function getLogisticsChannels(ctx: ShopeeShopContext): Promise<ShopeeLogisticsChannel[]> {
  const res = await shopeeShopRequest(ctx, { method: 'GET', path: SHOPEE_PATHS.getChannelList })
  return parseChannelList(res.data)
}

/**
 * Canais que podem entrar no logistic_info de um item simples:
 * habilitados na loja e SEM exigência de size_id (fee_type SIZE_SELECTION
 * exige escolher tamanho — UI de seleção fica para fase futura).
 */
export function usableLogisticsChannels(list: ShopeeLogisticsChannel[]): ShopeeLogisticsChannel[] {
  return list.filter((c) => c.enabled && c.fee_type !== 'SIZE_SELECTION')
}

/** Peso fora dos limites do canal (kg). null = dentro. */
export function weightOutsideChannel(channel: ShopeeLogisticsChannel, weightKg: number): string | null {
  if (channel.min_weight != null && weightKg < channel.min_weight) return `peso ${weightKg} kg abaixo do mínimo ${channel.min_weight} kg do canal ${channel.name}`
  if (channel.max_weight != null && weightKg > channel.max_weight) return `peso ${weightKg} kg acima do máximo ${channel.max_weight} kg do canal ${channel.name}`
  return null
}
