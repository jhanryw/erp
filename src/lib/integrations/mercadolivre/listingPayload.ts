/**
 * Montagem PURA do corpo de POST /items e interpretação da resposta do ML.
 *
 * Modelo vigente — User Products (doc "Preço por variação", 17/09/2026):
 *   - vendedor com tag `user_product_seller`: envia `family_name`, NÃO envia
 *     `title` (o ML gera) e NÃO envia array `variations` (cada variação é um
 *     item próprio, agrupado pelo ML em família via atributos CHILD_PK).
 *   - vendedor ainda no modelo anterior: envia `title`.
 * Em ambos os modelos o Qarvon publica 1 item por variação vendável — o mesmo
 * grão de channel_listings, então nada muda quando a conta migra de modelo.
 *
 * SKU: atributo SELLER_SKU (doc "Variações": "a maneira correta de carregar
 * o SKU é no atributo do item"), sempre o SKU vendável do Qarvon (kit: SKU
 * do kit — nunca de componente).
 */

import type { ChannelAttributeValue, ChannelListingDraft, ChannelListingSnapshot } from '@/lib/channels/types'

export type MercadoLivreListingModel = 'user_products' | 'legacy'

/** Formatos aceitos pelo ML (doc "Imagens", 24/03/2026): JPG, JPEG, PNG. */
const ACCEPTED_PICTURE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png'])

export interface PictureValidation {
  valid: string[]
  invalid: Array<{ url: string; reason: string }>
}

export function validatePictureUrls(urls: string[]): PictureValidation {
  const valid: string[] = []
  const invalid: Array<{ url: string; reason: string }> = []
  for (const url of urls) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      invalid.push({ url, reason: 'URL inválida' })
      continue
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      invalid.push({ url, reason: 'URL precisa ser http(s) pública' })
      continue
    }
    if (parsed.searchParams.has('token') || /\/object\/sign\//.test(parsed.pathname)) {
      invalid.push({ url, reason: 'URL assinada expira — o ML baixa a imagem depois' })
      continue
    }
    const ext = parsed.pathname.split('.').pop()?.toLowerCase() ?? ''
    if (!ACCEPTED_PICTURE_EXTENSIONS.has(ext)) {
      invalid.push({ url, reason: `formato .${ext || '?'} não aceito (use JPG ou PNG)` })
      continue
    }
    valid.push(url)
  }
  return { valid, invalid }
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : clean.slice(0, max).trimEnd()
}

/** Remove vazios, duplicados (último vence) e força SELLER_SKU = SKU vendável. */
export function normalizeAttributes(attributes: ChannelAttributeValue[], sellerSku: string): ChannelAttributeValue[] {
  const byId = new Map<string, ChannelAttributeValue>()
  for (const a of attributes) {
    const id = a.id?.trim().toUpperCase()
    if (!id || id === 'SELLER_SKU') continue
    const valueId = a.value_id?.toString().trim() || null
    const valueName = a.value_name?.toString().trim() || null
    if (!valueId && !valueName) continue
    byId.set(id, { id, ...(valueId ? { value_id: valueId } : {}), ...(valueName ? { value_name: valueName } : {}) })
  }
  byId.set('SELLER_SKU', { id: 'SELLER_SKU', value_name: sellerSku })
  return [...byId.values()]
}

export function buildItemBody(
  draft: ChannelListingDraft,
  model: MercadoLivreListingModel,
  maxTitleLength = 60,
): Record<string, unknown> {
  const opts = draft.channelOptions ?? {}
  const body: Record<string, unknown> = {
    category_id: draft.categoryId,
    price: Math.round(draft.price * 100) / 100,
    currency_id: draft.currencyId,
    available_quantity: Math.max(0, Math.floor(draft.quantity)),
    buying_mode: 'buy_it_now',
    listing_type_id: (opts.listing_type_id as string) || 'gold_special',
    condition: (opts.condition as string) || 'new',
    pictures: draft.pictureUrls.map((source) => ({ source })),
    attributes: normalizeAttributes(draft.attributes, draft.sellerSku),
  }
  if (model === 'user_products') {
    body.family_name = truncate(draft.productName, maxTitleLength)
  } else {
    body.title = truncate(draft.title, maxTitleLength)
  }
  if (Array.isArray(opts.sale_terms) && opts.sale_terms.length > 0) body.sale_terms = opts.sale_terms
  return body
}

/** Interpreta GET/POST /items/{id} em snapshot genérico. */
export function parseItem(item: Record<string, unknown>, extra: { familyId?: string | null; warnings?: string[] } = {}): ChannelListingSnapshot {
  const attributes = Array.isArray(item.attributes) ? (item.attributes as Array<Record<string, unknown>>) : []
  const skuAttr = attributes.find((a) => a.id === 'SELLER_SKU')
  const itemWarnings = Array.isArray(item.warnings)
    ? (item.warnings as Array<Record<string, unknown>>).map((w) => String(w.message ?? w.code ?? 'warning'))
    : []
  const variations = Array.isArray(item.variations) ? (item.variations as Array<Record<string, unknown>>) : []
  return {
    externalListingId: String(item.id),
    externalVariantId: variations.length === 1 && variations[0].id != null ? String(variations[0].id) : null,
    externalProductId: (item.user_product_id as string) ?? null,
    externalGroupId: extra.familyId ?? (item.family_id != null ? String(item.family_id) : null),
    externalIds: {
      ...(item.user_product_id ? { user_product_id: item.user_product_id } : {}),
      ...(item.family_name ? { family_name: item.family_name } : {}),
      ...(item.inventory_id ? { inventory_id: item.inventory_id } : {}),
      ...(item.catalog_product_id ? { catalog_product_id: item.catalog_product_id } : {}),
      ...(extra.familyId ? { family_id: extra.familyId } : {}),
    },
    externalCategoryId: (item.category_id as string) ?? null,
    listingTypeId: (item.listing_type_id as string) ?? null,
    externalStatus: (item.status as string) ?? null,
    externalSubStatus: Array.isArray(item.sub_status) ? (item.sub_status as string[]) : [],
    permalink: (item.permalink as string) ?? null,
    price: item.price != null ? Number(item.price) : null,
    quantity: item.available_quantity != null ? Number(item.available_quantity) : null,
    sellerSku: skuAttr ? String(skuAttr.value_name ?? '') || null : (item.seller_custom_field as string) ?? null,
    title: (item.title as string) ?? null,
    pictureCount: Array.isArray(item.pictures) ? (item.pictures as unknown[]).length : 0,
    warnings: [...itemWarnings, ...(extra.warnings ?? [])],
  }
}

/**
 * Mapeamento Qarvon → atributos do ML por SEMÂNTICA (não por segmento):
 * só propõe valores iniciais para ids de atributo universais do ML quando a
 * categoria os tiver; o usuário confere/ajusta tudo no formulário. Para
 * atributos de lista, tenta casar o texto com um value_id do ML.
 */
export function suggestAttributeValues(
  definitions: Array<{ id: string; values: Array<{ id: string; name: string }> }>,
  source: { brand: string | null; model: string | null; color: string | null; size: string | null },
): ChannelAttributeValue[] {
  const semantic: Record<string, string | null> = {
    BRAND: source.brand,
    MODEL: source.model,
    COLOR: source.color,
    MAIN_COLOR: source.color,
    SIZE: source.size,
  }
  const out: ChannelAttributeValue[] = []
  for (const def of definitions) {
    const text = semantic[def.id]
    if (!text) continue
    const match = def.values.find((v) => v.name.localeCompare(text, 'pt-BR', { sensitivity: 'base' }) === 0)
    out.push(match ? { id: def.id, value_id: match.id, value_name: match.name } : { id: def.id, value_name: text })
  }
  return out
}
