/**
 * Montagem PURA do corpo de v2.product.add_item e leitura de
 * get_item_base_info. Conceitos Shopee (item_id, image_id, brand_id,
 * logistic_id, attribute_id) ficam AQUI e no adapter — o core
 * (listings.service / ChannelListingDraft) continua genérico.
 *
 * Fonte dos campos: referência oficial v2.product.add_item (lida em
 * 28/09/2026 via navegador em open.shopee.com/documents):
 *   original_price float (obrig.), description string (obrig.),
 *   weight float kg (obrig.), item_name (obrig.), item_status NORMAL|UNLIST,
 *   dimension {package_height, package_length, package_width} int cm
 *   (opcional; se enviado, os 3 são obrigatórios), logistic_info[{logistic_id,
 *   enabled}] (obrig.), attribute_list[{attribute_id, attribute_value_list[
 *   {value_id, original_value_name, value_unit}]}], category_id (obrig.),
 *   image.image_id_list (obrig.), item_sku, condition ("NEW"/"USED" —
 *   obrigatório no BR desde 2026-09-01, Update Log), brand {brand_id,
 *   original_brand_name}, seller_stock[{location_id?, stock}].
 *
 * tax_info (reconfirmado em 28/09/2026, mesma página): objeto OPCIONAL;
 *   todos os subcampos "Required: False" — ncm (8 dígitos ou "00"),
 *   same_state_cfop, diff_state_cfop, csosn, origin (0-8), cest (7 dígitos
 *   ou "00"), measure_unit (lista fechada, maiúsculas), pis, cofins, icms_cst…
 *   O Qarvon envia SÓ o que é atributo do produto e já existe no PIM
 *   (products.ncm/cest/origem/unidade_med). CFOP/CSOSN são operacionais
 *   (regime da empresa × destino) — NÃO são enviados nem modelados no produto.
 *
 * Peso/dimensões: fonte primária = draft.shippingDimensions (PIM, resolvido
 * pelo core). channelOptions.shopee.weight_kg/dimension são FALLBACK manual,
 * usados só quando o PIM não tem o dado. Demais opções específicas (condição,
 * marca, atributos, logística) continuam em draft.channelOptions.shopee.
 */

import type { ChannelListingDraft, ChannelListingSnapshot, ChannelValidationResult } from '@/lib/channels/types'
import type { ShopeeAttributeDefinition, ShopeeBrandInfo, ShopeeCategoryDetails, ShopeeLogisticsChannel } from './catalog'
import { usableLogisticsChannels, weightOutsideChannel } from './catalog'

/** Valores aceitos na doc de add_item (a API também mapeia new/used, mas o Qarvon envia o canônico). */
export const SHOPEE_CONDITIONS = ['NEW', 'USED'] as const
export type ShopeeCondition = typeof SHOPEE_CONDITIONS[number]

export const SHOPEE_ITEM_STATUSES = ['NORMAL', 'UNLIST'] as const
export type ShopeeItemStatus = typeof SHOPEE_ITEM_STATUSES[number]

/** Limite prudente de imagens por item (não confirmado na doc de add_item — ver relatório). */
export const MAX_ITEM_IMAGES = 9

export interface ShopeeAttributeInput {
  attribute_id: number
  values: Array<{ value_id: number; original_value_name?: string | null; value_unit?: string | null }>
}

/** Marca escolhida: id da lista da API, ou "sem marca" (resolvido pela entrada que a API oferecer). */
export type ShopeeBrandInput = { brand_id: number; original_brand_name: string } | { no_brand: true }

export interface ShopeeListingOptions {
  condition?: string | null
  weight_kg?: number | null
  dimension?: { package_height?: number | null; package_length?: number | null; package_width?: number | null } | null
  brand?: ShopeeBrandInput | null
  attributes?: ShopeeAttributeInput[]
  /** null/ausente = primeiro canal habilitado utilizável (ver chooseLogisticsChannel). */
  logistic_channel_id?: number | null
  item_status?: string | null
}

export type ValidationIssue = { code: string; message: string }

export function readShopeeOptions(draft: Pick<ChannelListingDraft, 'channelOptions'>): ShopeeListingOptions {
  const raw = (draft.channelOptions ?? {}).shopee
  return raw && typeof raw === 'object' ? (raw as ShopeeListingOptions) : {}
}

const isPosInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0

// ─── Dados físicos: PIM primeiro, override manual como fallback ─────────────

export type PhysicalSource = 'pim' | 'manual' | 'none'

export interface EffectivePhysical {
  weightKg: number | null
  weightSource: PhysicalSource
  dimension: { package_height: number; package_length: number; package_width: number } | null
  dimensionSource: PhysicalSource
  errors: ValidationIssue[]
}

/**
 * Peso: PIM (draft.shippingDimensions.weightKg) → channelOptions.shopee.weight_kg → erro missing_weight.
 * Dimensões: PIM completo → PIM; PIM parcial → incomplete_dimensions (não
 * mistura com manual); PIM vazio → manual (tudo ou nada); nada → omitido.
 */
export function resolveEffectivePhysical(draft: Pick<ChannelListingDraft, 'channelOptions' | 'shippingDimensions'>): EffectivePhysical {
  const o = readShopeeOptions(draft)
  const pim = draft.shippingDimensions ?? null
  const errors: ValidationIssue[] = []
  const invalid = pim?.invalid ?? []

  let weightKg: number | null = null
  let weightSource: PhysicalSource = 'none'
  if (invalid.some((f) => f.startsWith('weightKg@'))) {
    errors.push({ code: 'invalid_weight', message: 'Peso cadastrado no produto/variação é inválido (kg, maior que zero).' })
  } else if (pim?.weightKg != null) {
    weightKg = pim.weightKg; weightSource = 'pim'
  } else if (o.weight_kg != null) {
    weightKg = o.weight_kg; weightSource = 'manual'
  }
  if (weightSource === 'none' && errors.length === 0) {
    errors.push({ code: 'missing_weight', message: 'Peso (kg) é obrigatório na Shopee: cadastre-o no produto (Dados físicos) ou na variação.' })
  } else if (weightKg != null && !(typeof weightKg === 'number' && Number.isFinite(weightKg) && weightKg > 0)) {
    errors.push({ code: 'invalid_weight', message: 'Peso inválido (kg, maior que zero).' })
  }

  let dimension: EffectivePhysical['dimension'] = null
  let dimensionSource: PhysicalSource = 'none'
  const pimDims = pim ? [pim.heightCm, pim.lengthCm, pim.widthCm] : [null, null, null]
  if (invalid.some((f) => /^(lengthCm|widthCm|heightCm)@/.test(f))) {
    errors.push({ code: 'invalid_dimensions', message: 'Dimensões cadastradas no produto/variação são inválidas (cm inteiros, maiores que zero).' })
  } else if (pim?.dimensionsPartial || (pimDims.some((x) => x != null) && !pimDims.every((x) => x != null))) {
    errors.push({ code: 'incomplete_dimensions', message: 'Dimensões do produto incompletas: cadastre comprimento, largura e altura juntas (ou nenhuma).' })
  } else if (pimDims.every((x) => x != null)) {
    if (!pimDims.every(isPosInt)) errors.push({ code: 'invalid_dimensions', message: 'Dimensões precisam ser inteiros positivos (cm).' })
    else { dimension = { package_height: pim!.heightCm!, package_length: pim!.lengthCm!, package_width: pim!.widthCm! }; dimensionSource = 'pim' }
  } else if (o.dimension) {
    const d = o.dimension
    const parts = [d.package_height, d.package_length, d.package_width]
    const given = parts.filter((p) => p != null)
    if (given.length > 0 && given.length < 3) {
      errors.push({ code: 'incomplete_dimensions', message: 'Dimensões: informe altura, comprimento e largura juntas (ou nenhuma).' })
    } else if (given.length === 3 && !parts.every(isPosInt)) {
      errors.push({ code: 'invalid_dimensions', message: 'Dimensões precisam ser inteiros positivos (cm).' })
    } else if (given.length === 3) {
      dimension = { package_height: d.package_height!, package_length: d.package_length!, package_width: d.package_width! }; dimensionSource = 'manual'
    }
  }
  return { weightKg, weightSource, dimension, dimensionSource, errors }
}

// ─── Fiscal (tax_info): só dados do PRODUTO já existentes no PIM ─────────────

/** measure_unit aceitos pela doc de add_item (BR). */
export const SHOPEE_MEASURE_UNITS = ['AMPOLA', 'BALDE', 'BANDEJ', 'BARRA', 'BISNAG', 'BLOCO', 'BOBINA', 'BOMB', 'CAPS', 'CART', 'CENTO', 'CJ', 'CM', 'CM2', 'CX', 'CX2', 'CX3', 'CX5', 'CX10', 'CX15', 'CX20', 'CX25', 'CX50', 'CX100', 'DISP', 'DUZIA', 'EMBAL', 'FARDO', 'FOLHA', 'FRASCO', 'GALAO', 'GF', 'GRAMAS', 'JOGO', 'KG', 'KIT', 'LATA', 'LITRO', 'M', 'M2', 'M3', 'MILHEI', 'ML', 'MWH', 'PACOTE', 'PALETE', 'PARES', 'PC', 'POTE', 'K', 'RESMA', 'ROLO', 'SACO', 'SACOLA', 'TAMBOR', 'TANQUE', 'TON', 'TUBO', 'UN', 'VASIL', 'VIDRO'] as const

/** unidade_med do Qarvon → vocabulário Shopee quando o código difere. */
const MEASURE_UNIT_ALIASES: Record<string, string> = { PAR: 'PARES', L: 'LITRO', G: 'GRAMAS' }

export interface ShopeeTaxInfo { ncm?: string; cest?: string; origin?: string; measure_unit?: string }

/**
 * tax_info a partir de draft.fiscalInfo. Tudo opcional na doc: ausente →
 * omitido (sem aviso, para não poluir last_error). Presente e mal formado → erro (evita rejeição
 * da Shopee com dado fiscal errado). Nunca envia CFOP/CSOSN.
 */
export function buildTaxInfo(draft: Pick<ChannelListingDraft, 'fiscalInfo'>): { taxInfo: ShopeeTaxInfo | null; errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  const f = draft.fiscalInfo ?? null
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const tax: ShopeeTaxInfo = {}
  const ncmRaw = (f?.ncm ?? '').toString().trim()
  if (ncmRaw) {
    const ncm = ncmRaw.replace(/\D/g, '')
    if (/^\d{8}$/.test(ncm)) tax.ncm = ncm
    else errors.push({ code: 'invalid_ncm', message: `NCM do produto inválido ("${ncmRaw}"): precisa ter 8 dígitos.` })
  }
  const cestRaw = (f?.cest ?? '').toString().trim()
  if (cestRaw) {
    const cest = cestRaw.replace(/\D/g, '')
    if (/^\d{7}$/.test(cest)) tax.cest = cest
    else errors.push({ code: 'invalid_cest', message: `CEST do produto inválido ("${cestRaw}"): precisa ter 7 dígitos.` })
  }
  if (f?.origin != null) {
    if (Number.isInteger(f.origin) && f.origin >= 0 && f.origin <= 8) tax.origin = String(f.origin)
    else errors.push({ code: 'invalid_origin', message: 'Origem da mercadoria inválida (0 a 8).' })
  }
  const unitRaw = (f?.measureUnit ?? '').toString().trim().toUpperCase()
  if (unitRaw) {
    const unit = MEASURE_UNIT_ALIASES[unitRaw] ?? unitRaw
    if ((SHOPEE_MEASURE_UNITS as readonly string[]).includes(unit)) tax.measure_unit = unit
    else warnings.push({ code: 'measure_unit_not_supported', message: `Unidade "${unitRaw}" não existe na lista da Shopee: measure_unit não será enviado.` })
  }
  return { taxInfo: Object.keys(tax).length ? tax : null, errors, warnings }
}

// ─── Validação local (sem API) ───────────────────────────────────────────────

/**
 * Tudo o que dá para bloquear SEM chamar a Shopee. Peso é SEMPRE exigido
 * (PIM ou override manual) — nunca há valor padrão.
 */
export function validateDraftLocally(draft: ChannelListingDraft): ValidationIssue[] {
  const o = readShopeeOptions(draft)
  const errors: ValidationIssue[] = []
  if (!draft.title?.trim()) errors.push({ code: 'missing_name', message: 'Nome do produto ausente.' })
  if (!draft.description?.trim()) errors.push({ code: 'missing_description', message: 'Descrição é obrigatória na Shopee.' })
  if (!(typeof draft.price === 'number' && Number.isFinite(draft.price) && draft.price > 0)) errors.push({ code: 'invalid_price', message: 'Preço ausente ou inválido.' })
  if (!(typeof draft.quantity === 'number' && Number.isInteger(draft.quantity) && draft.quantity >= 0)) errors.push({ code: 'missing_stock', message: 'Estoque não informado.' })
  if (!draft.sellerSku?.trim()) errors.push({ code: 'missing_sku', message: 'SKU ausente.' })
  if (!draft.pictureUrls?.length) errors.push({ code: 'missing_images', message: 'Nenhuma imagem pública do Media Hub.' })
  if (!/^\d{1,12}$/.test(String(draft.categoryId ?? '')) || Number(draft.categoryId) <= 0) errors.push({ code: 'invalid_category', message: 'Categoria Shopee ausente ou inválida.' })

  errors.push(...resolveEffectivePhysical(draft).errors)
  errors.push(...buildTaxInfo(draft).errors)

  if (o.condition == null || String(o.condition).trim() === '') {
    errors.push({ code: 'missing_condition', message: 'Condição (NEW/USED) é obrigatória na Shopee Brasil.' })
  } else if (!(SHOPEE_CONDITIONS as readonly string[]).includes(String(o.condition))) {
    errors.push({ code: 'invalid_condition', message: `Condição inválida: use ${SHOPEE_CONDITIONS.join(' ou ')}.` })
  }
  if (o.item_status != null && !(SHOPEE_ITEM_STATUSES as readonly string[]).includes(String(o.item_status))) {
    errors.push({ code: 'invalid_item_status', message: 'item_status inválido (NORMAL ou UNLIST).' })
  }
  if (o.logistic_channel_id != null && !isPosInt(o.logistic_channel_id)) {
    errors.push({ code: 'invalid_logistic_channel', message: 'Canal logístico inválido.' })
  }
  return errors
}

// ─── Validação contra os requisitos vivos da categoria/loja ─────────────────

export interface ShopeeRequirementsSnapshot {
  category: ShopeeCategoryDetails
  attributes: ShopeeAttributeDefinition[]
  brand: ShopeeBrandInfo
  logistics: ShopeeLogisticsChannel[]
}

export interface ResolvedShopeeChoices {
  attributeList: ShopeeAttributeInput[]
  brand: { brand_id: number; original_brand_name: string } | null
  logisticChannelId: number | null
}

/** Canal escolhido: o informado (se utilizável) ou o PRIMEIRO habilitado utilizável. */
export function chooseLogisticsChannel(logistics: ShopeeLogisticsChannel[], wanted: number | null | undefined): ShopeeLogisticsChannel | null {
  const usable = usableLogisticsChannels(logistics)
  if (wanted != null) return usable.find((c) => c.logistics_channel_id === wanted) ?? null
  return usable[0] ?? null
}

function attributeFilled(a: ShopeeAttributeInput | undefined): boolean {
  return Boolean(a && a.values.some((v) => (isPosInt(v.value_id)) || (v.value_id === 0 && (v.original_value_name ?? '').toString().trim())))
}

export function validateAgainstRequirements(draft: ChannelListingDraft, req: ShopeeRequirementsSnapshot): { errors: ValidationIssue[]; warnings: ValidationIssue[]; resolved: ResolvedShopeeChoices } {
  const o = readShopeeOptions(draft)
  const physical = resolveEffectivePhysical(draft)
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  if (!req.category.is_leaf) errors.push({ code: 'category_not_leaf', message: 'Escolha uma categoria final (sem subcategorias).' })

  // Atributos: preserva IDs oficiais; confere obrigatórios e value_id permitidos.
  const defs = new Map(req.attributes.map((a) => [a.attribute_id, a]))
  const byId = new Map<number, ShopeeAttributeInput>()
  for (const a of o.attributes ?? []) {
    if (!isPosInt(a?.attribute_id) || !Array.isArray(a.values)) {
      errors.push({ code: 'invalid_attribute', message: 'Atributo com formato inválido.' })
      continue
    }
    byId.set(a.attribute_id, a)
  }
  for (const def of req.attributes) {
    if (def.mandatory && !attributeFilled(byId.get(def.attribute_id))) {
      errors.push({ code: 'missing_attribute', message: `Atributo obrigatório sem valor: ${def.name} (${def.attribute_id}).` })
    }
  }
  const attributeList: ShopeeAttributeInput[] = []
  for (const [id, a] of byId) {
    const def = defs.get(id)
    if (!def) { errors.push({ code: 'invalid_attribute', message: `Atributo ${id} não pertence à categoria.` }); continue }
    const values = a.values.filter((v) => isPosInt(v.value_id) || (v.value_id === 0 && (v.original_value_name ?? '').toString().trim()))
    if (values.length === 0) continue
    if (!def.multiple && values.length > 1) errors.push({ code: 'invalid_attribute_value', message: `${def.name}: aceita um único valor.` })
    if (def.max_value_count != null && def.max_value_count > 0 && values.length > def.max_value_count) {
      errors.push({ code: 'invalid_attribute_value', message: `${def.name}: no máximo ${def.max_value_count} valor(es).` })
    }
    for (const v of values) {
      if (v.value_id === 0) {
        if (!def.accepts_custom_value) errors.push({ code: 'invalid_attribute_value', message: `${def.name}: escolha um valor da lista (não aceita texto livre).` })
        if (def.quantitative && def.units.length && !(v.value_unit && def.units.includes(v.value_unit))) {
          errors.push({ code: 'invalid_attribute_value', message: `${def.name}: unidade obrigatória (${def.units.join(', ')}).` })
        }
      } else if (def.values.length > 0 && !def.values.some((x) => x.value_id === v.value_id) && !def.support_search_value) {
        errors.push({ code: 'invalid_attribute_value', message: `${def.name}: valor ${v.value_id} não é permitido.` })
      }
    }
    attributeList.push({ attribute_id: id, values })
  }

  // Marca: obrigatória só se a API disser; "sem marca" só se a API oferecer a entrada.
  let brand: ResolvedShopeeChoices['brand'] = null
  const b = o.brand
  if (b && 'no_brand' in b) {
    if (req.brand.no_brand_option) {
      brand = { brand_id: req.brand.no_brand_option.brand_id, original_brand_name: req.brand.no_brand_option.original_brand_name }
    } else if (req.brand.is_mandatory) {
      errors.push({ code: 'no_brand_not_offered', message: 'A Shopee não oferece "No Brand" nesta categoria: escolha uma marca da lista.' })
    }
  } else if (b) {
    const found = req.brand.brands.find((x) => x.brand_id === b.brand_id)
    if (!isPosInt(b.brand_id) && !(req.brand.no_brand_option && b.brand_id === req.brand.no_brand_option.brand_id)) {
      errors.push({ code: 'invalid_brand', message: 'Marca inválida.' })
    } else if (!found && !req.brand.truncated) {
      errors.push({ code: 'invalid_brand', message: `Marca ${b.brand_id} não está disponível para esta categoria.` })
    } else {
      brand = { brand_id: b.brand_id, original_brand_name: found?.original_brand_name ?? String(b.original_brand_name ?? '').trim() }
      if (!brand.original_brand_name) errors.push({ code: 'invalid_brand', message: 'Marca sem nome.' })
    }
  } else if (req.brand.is_mandatory) {
    errors.push({ code: 'missing_brand', message: 'Marca é obrigatória nesta categoria.' })
  }

  // Logística mínima: 1 canal habilitado e compatível com o peso.
  const channel = chooseLogisticsChannel(req.logistics, o.logistic_channel_id)
  if (!channel) {
    errors.push(o.logistic_channel_id != null
      ? { code: 'invalid_logistic_channel', message: `Canal logístico ${o.logistic_channel_id} não está habilitado/utilizável nesta loja.` }
      : { code: 'logistics_unavailable', message: 'Nenhum canal logístico habilitado na loja Shopee.' })
  } else if (typeof physical.weightKg === 'number') {
    const out = weightOutsideChannel(channel, physical.weightKg)
    if (out) errors.push({ code: 'weight_out_of_channel_limits', message: out })
  }
  warnings.push(...buildTaxInfo(draft).warnings)
  if (req.brand.truncated) warnings.push({ code: 'brand_list_truncated', message: 'Lista de marcas parcial (muitas páginas).' })

  return { errors, warnings, resolved: { attributeList, brand, logisticChannelId: channel?.logistics_channel_id ?? null } }
}

export function toValidationResult(errors: ValidationIssue[], warnings: ValidationIssue[] = []): ChannelValidationResult {
  return { ok: errors.length === 0, errors, warnings }
}

// ─── Corpo do add_item ───────────────────────────────────────────────────────

export interface AddItemInputs {
  imageIds: string[]
  choices: ResolvedShopeeChoices
}

export function buildAddItemBody(draft: ChannelListingDraft, inputs: AddItemInputs): Record<string, unknown> {
  const o = readShopeeOptions(draft)
  if (!inputs.choices.logisticChannelId) throw new Error('buildAddItemBody: canal logístico ausente')
  if (inputs.imageIds.length === 0) throw new Error('buildAddItemBody: sem image_id')
  const physical = resolveEffectivePhysical(draft)
  if (physical.errors.length || physical.weightKg == null) throw new Error('buildAddItemBody: peso/dimensões inválidos')
  const tax = buildTaxInfo(draft)
  if (tax.errors.length) throw new Error('buildAddItemBody: dados fiscais inválidos')
  const body: Record<string, unknown> = {
    original_price: Math.round(draft.price * 100) / 100,
    description: draft.description!.trim(),
    weight: physical.weightKg,
    item_name: draft.title.trim(),
    item_status: (o.item_status as ShopeeItemStatus | null | undefined) ?? 'NORMAL',
    logistic_info: [{ logistic_id: inputs.choices.logisticChannelId, enabled: true }],
    category_id: Number(draft.categoryId),
    image: { image_id_list: inputs.imageIds },
    item_sku: draft.sellerSku,
    condition: o.condition,
    seller_stock: [{ stock: draft.quantity }],
  }
  if (physical.dimension) body.dimension = physical.dimension
  if (tax.taxInfo) body.tax_info = tax.taxInfo
  if (inputs.choices.attributeList.length) {
    body.attribute_list = inputs.choices.attributeList.map((a) => ({
      attribute_id: a.attribute_id,
      attribute_value_list: a.values.map((v) => ({
        value_id: v.value_id,
        ...(v.value_id === 0 ? { original_value_name: String(v.original_value_name ?? '').trim() } : {}),
        ...(v.value_unit ? { value_unit: v.value_unit } : {}),
      })),
    }))
  }
  if (inputs.choices.brand) body.brand = inputs.choices.brand
  return body
}

// ─── Leitura do item ─────────────────────────────────────────────────────────

/**
 * Status Shopee (get_item_base_info: NORMAL, BANNED, UNLIST, SELLER_DELETE,
 * SHOPEE_DELETE, REVIEWING) → vocabulário do core. UNLIST não é
 * 'paused_by_seller' automaticamente: pausa manual é decisão do Qarvon.
 */
export function mapItemStatus(raw: string | null): string | null {
  switch (raw) {
    case 'NORMAL': return 'active'
    case 'UNLIST': return 'paused'
    case 'REVIEWING': return 'under_review'
    case 'BANNED': return 'inactive'
    case 'SELLER_DELETE':
    case 'SHOPEE_DELETE': return 'closed'
    default: return raw ? raw.toLowerCase() : null
  }
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** item de get_item_base_info (ou response do add_item) → snapshot genérico. */
export function snapshotFromItem(item: Record<string, unknown>, shopId: string, fallback: { quantity?: number | null; sellerSku?: string | null } = {}): ChannelListingSnapshot {
  const itemId = num(item.item_id)
  if (itemId == null || itemId <= 0) throw new Error('snapshotFromItem: item sem item_id')
  const rawStatus = typeof item.item_status === 'string' ? item.item_status : null
  const priceInfo = Array.isArray(item.price_info) ? (item.price_info[0] as Record<string, unknown> | undefined) : (item.price_info as Record<string, unknown> | undefined)
  const stock = (item.stock_info_v2 as { summary_info?: { total_available_stock?: unknown } } | undefined)?.summary_info?.total_available_stock
  const images = (item.image ?? item.images) as { image_id_list?: unknown[] } | undefined
  const sku = typeof item.item_sku === 'string' && item.item_sku ? item.item_sku : (fallback.sellerSku ?? null)
  const category = num(item.category_id)
  return {
    externalListingId: String(itemId),
    externalVariantId: null,
    // Produto simples: o item É o produto na Shopee (sem model).
    externalProductId: String(itemId),
    externalGroupId: null,
    externalIds: { item_id: String(itemId), shop_id: shopId },
    externalCategoryId: category != null ? String(category) : null,
    externalStatus: mapItemStatus(rawStatus),
    externalSubStatus: rawStatus ? [rawStatus.toLowerCase()] : [],
    // URL pública do item não confirmada na doc — não inventada.
    permalink: null,
    price: num(priceInfo?.original_price) ?? num(item.original_price),
    quantity: num(stock) ?? fallback.quantity ?? null,
    sellerSku: sku,
    title: typeof item.item_name === 'string' ? item.item_name : null,
    pictureCount: Array.isArray(images?.image_id_list) ? images!.image_id_list!.length : 0,
    warnings: [],
    sellerId: item.shop_id != null ? String(item.shop_id) : shopId,
  }
}
