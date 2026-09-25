/**
 * Publicação canônica de produto ERP → Nuvemshop.
 *
 * Todas as rotas de envio (página do produto, /configuracoes/nuvemshop,
 * envio em massa) delegam para `publishProductToNuvemshop`.
 *
 * Garantias:
 *   - Mapping existente é VERIFICADO na Nuvemshop (GET). Remoto 404 →
 *     mapping invalidado e o produto é criado de novo (novos IDs substituem
 *     os antigos). Remoto existente → nunca cria outro produto; só repara
 *     vínculos de variante por SKU.
 *   - SKU ausente/duplicado bloqueia ANTES de qualquer chamada remota.
 *   - Variantes são pareadas por SKU, nunca por posição.
 *   - Antes de criar, procura o SKU na loja: se já existir produto remoto
 *     com esse SKU sem vínculo (ex.: criação anterior cujo mapping falhou),
 *     recusa em vez de duplicar — o usuário decide.
 *   - Nunca exclui nada remoto.
 *   - Imagens vêm do Media Hub (helper compartilhado com o Mercado Livre) e
 *     são enviadas SOMENTE no caminho de criação inicial: até 9 no
 *     POST /products e o restante via POST /products/{id}/images. Produto já
 *     publicado nunca recebe imagens de novo (evita duplicação).
 *   - Preço por variação = price_override ?? base_price.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import {
  addNuvemshopProductImage,
  createNuvemshopProductFull,
  getNuvemshopProduct,
  getNuvemshopProductBySku,
  NuvemshopTransportError,
  type NuvemshopImageInput,
  type NuvemshopProductResponse,
} from '@/lib/integrations/nuvemshop'
import {
  loadProductPicturesProductFirst,
  validatePublicPictures,
  type OrderedProductPicture,
} from '@/services/catalog/productPictures'
import type { NuvemshopContext } from './context.service'
import {
  getNuvemshopProductMapping,
  invalidateNuvemshopProductMapping,
  invalidateNuvemshopVariantMapping,
  logNuvemshopEvent,
  saveNuvemshopProductMapping,
  saveNuvemshopVariantMapping,
  type NuvemshopMappingRow,
  type NuvemshopProductMapping,
} from './mappings.service'
import { pairVariantsBySku, validateErpSkus, type SkuValidationIssue, type VariantPairingResult } from './variantPairing'

export type PublishStatus = 'published' | 'already_published' | 'relinked' | 'inconsistent' | 'failed'

export type PublishFailureCode =
  | 'not_found'
  | 'inactive'
  | 'no_active_variations'
  | 'invalid_sku'
  | 'remote_sku_conflict'
  | 'remote_error'
  | 'mapping_persist_failed'
  | 'db_error'
  | 'no_images'
  | 'invalid_price'
  | 'publish_in_progress'

export interface PublishResult {
  status:                   PublishStatus
  productId:                number
  productName?:             string
  remoteProductId?:         string
  /** Produto remoto antigo (excluído na Nuvemshop) cujo vínculo foi substituído. */
  previousRemoteProductId?: string
  variantsMapped?:          number
  stockTotal?:              number
  code?:                    PublishFailureCode
  message?:                 string
  skuIssues?:               SkuValidationIssue[]
  unmatched?:               VariantPairingResult['unmatched']
  /** Só no caminho de criação. */
  images?:                  PublishImageReport
  /** Avisos não fatais (ex.: falha parcial de imagens). */
  warnings?:                string[]
}

export interface PublishImageReport {
  /** Imagens públicas encontradas no Media Hub (após dedupe). */
  found:          number
  /** Enviadas no POST /products. */
  sentInitial:    number
  /** Enviadas depois, via POST /products/{id}/images. */
  sentAfter:      number
  /** Não chegaram à Nuvemshop (recusa no payload inicial ou falha posterior). */
  failed:         number
  /** Mídias ignoradas antes do envio (formato/URL). */
  skippedInvalid: Array<{ url: string; reason: string }>
}

/** Recomendação da Nuvemshop: até 9 imagens no POST /products; o resto pelo endpoint de imagens. */
export const NUVEMSHOP_INITIAL_IMAGE_LIMIT = 9
/** Formatos aceitos pela API de imagens da Nuvemshop (gif, jpg, png, webp). */
export const NUVEMSHOP_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp']

type AttributeRow = {
  variation_types:  { name: string; slug: string } | null
  variation_values: { value: string; slug: string } | null
}

type VariationRow = {
  id:                           number
  sku_variation:                string | null
  price_override:               number | string | null
  product_variation_attributes: AttributeRow[] | null
}

type ProductRow = { id: number; name: string; base_price: number | string; active: boolean }

const failed = (productId: number, code: PublishFailureCode, message: string, extra: Partial<PublishResult> = {}): PublishResult =>
  ({ status: 'failed', productId, code, message, ...extra })

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function loadProduct(companyId: number, productId: number): Promise<{ product: ProductRow | null; variations: VariationRow[]; error?: string }> {
  const admin = createAdminClient()
  const { data: product, error } = await (admin as any)
    .from('products')
    .select('id, name, base_price, active')
    .eq('id', productId)
    .eq('company_id', companyId)
    .maybeSingle() as { data: ProductRow | null; error: { message: string } | null }
  if (error) return { product: null, variations: [], error: error.message }
  if (!product) return { product: null, variations: [] }

  const { data: variations, error: varErr } = await (admin as any)
    .from('product_variations')
    .select(`
      id,
      sku_variation,
      price_override,
      product_variation_attributes (
        variation_type_id,
        variation_value_id,
        variation_types:variation_type_id ( name, slug ),
        variation_values:variation_value_id ( value, slug )
      )
    `)
    .eq('product_id', productId)
    .eq('active', true)
    .order('id', { ascending: true }) as { data: VariationRow[] | null; error: { message: string } | null }
  if (varErr) return { product, variations: [], error: varErr.message }
  return { product, variations: variations ?? [] }
}

/**
 * Soma de stock_balances nos locais ativos (mesma regra do envio anterior).
 * Erro de banco → ok:false: a publicação é abortada, nunca cria remoto com 0.
 */
async function loadStockByVariation(variationIds: number[]): Promise<{ ok: true; data: Map<number, number> } | { ok: false; error: string }> {
  const out = new Map<number, number>()
  if (variationIds.length === 0) return { ok: true, data: out }
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('stock_balances')
    .select('product_variation_id, quantity, stock_locations!inner(active)')
    .in('product_variation_id', variationIds)
    .eq('stock_locations.active', true) as { data: Array<{ product_variation_id: number; quantity: number }> | null; error: { message: string } | null }
  if (error || !data) return { ok: false, error: error?.message ?? 'sem resposta' }
  for (const row of data) out.set(row.product_variation_id, (out.get(row.product_variation_id) ?? 0) + (row.quantity ?? 0))
  return { ok: true, data: out }
}

/**
 * Preço enviado por variação: price_override ?? base_price. Devolve null
 * quando não é um número finito ≥ 0 (nunca manda NaN/negativo).
 */
export function resolveVariationPrice(priceOverride: number | string | null | undefined, basePrice: number | string | null | undefined): number | null {
  const raw = priceOverride != null && priceOverride !== '' ? priceOverride : basePrice
  if (raw == null || raw === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100) / 100
}

function buildPayload(
  product: ProductRow,
  variations: VariationRow[],
  stock: Map<number, number>,
  prices: Map<number, number>,
  images: NuvemshopImageInput[],
) {
  const typeOrder: Record<string, number> = { cor: 0, tamanho: 1 }
  const attributeTypeMap = new Map<string, string>()
  for (const v of variations) {
    for (const attr of v.product_variation_attributes ?? []) {
      if (attr.variation_types?.slug && attr.variation_types?.name) attributeTypeMap.set(attr.variation_types.slug, attr.variation_types.name)
    }
  }
  const attributeSlugs = [...attributeTypeMap.keys()].sort((a, b) => (typeOrder[a] ?? 99) - (typeOrder[b] ?? 99))
  const attributeNames = attributeSlugs.map((slug) => attributeTypeMap.get(slug)!)

  const variants = variations.map((v) => {
    const attrBySlug = new Map<string, string>()
    for (const attr of v.product_variation_attributes ?? []) {
      const slug = attr.variation_types?.slug
      const value = attr.variation_values?.value
      if (slug && value) attrBySlug.set(slug, value)
    }
    return {
      internalVariationId: v.id,
      price:               prices.get(v.id)!,
      stock:               stock.get(v.id) ?? 0,
      sku:                 (v.sku_variation ?? '').trim(),
      attributeValues:     attributeSlugs.map((slug) => attrBySlug.get(slug) ?? ''),
    }
  })

  return {
    name:      product.name,
    images:    images.length > 0 ? images : undefined,
    attributeNames,
    variants,
    published: false,
  }
}

function distinctRemoteIds(mapping: NuvemshopProductMapping): string[] {
  const ids = new Set<string>()
  if (mapping.productRow) ids.add(String(mapping.productRow.external_id))
  for (const r of mapping.variantRows) ids.add(String(r.external_id))
  return [...ids]
}

/** Produto remoto existe: remove vínculos de variante mortos e repara faltantes por SKU. */
async function repairExistingPublication(
  ctx: NuvemshopContext,
  product: ProductRow,
  variations: VariationRow[],
  mapping: NuvemshopProductMapping,
  remote: NuvemshopProductResponse,
): Promise<PublishResult> {
  const remoteId = String(remote.id)
  const remoteVariantIds = new Set((remote.variants ?? []).map((v) => String(v.id)))
  let changed = false

  const validRows: NuvemshopMappingRow[] = []
  for (const row of mapping.variantRows) {
    if (String(row.external_id) !== remoteId) continue
    if (row.external_variant_id && remoteVariantIds.has(String(row.external_variant_id))) { validRows.push(row); continue }
    const inv = await invalidateNuvemshopVariantMapping(ctx.companyId, row.product_variation_id!, {
      expectedRemoteVariantId: String(row.external_variant_id), reason: 'publish_remote_variant_missing',
    })
    if (!inv.ok) return failed(product.id, 'db_error', inv.error, { productName: product.name, remoteProductId: remoteId })
    changed = true
  }

  if (!mapping.productRow || String(mapping.productRow.external_id) !== remoteId) {
    const saved = await saveNuvemshopProductMapping(ctx.companyId, product.id, remoteId)
    if (!saved.ok) return failed(product.id, 'db_error', saved.error, { productName: product.name, remoteProductId: remoteId })
    changed = true
  }

  const mappedVariationIds = new Set(validRows.map((r) => r.product_variation_id))
  const missing = variations.filter((v) => !mappedVariationIds.has(v.id))

  if (missing.length === 0) {
    return { status: changed ? 'relinked' : 'already_published', productId: product.id, productName: product.name, remoteProductId: remoteId, variantsMapped: validRows.length }
  }

  const pairing = pairVariantsBySku(
    missing.map((v) => ({ variationId: v.id, sku: v.sku_variation })),
    remote.variants ?? [],
    validRows.map((r) => String(r.external_variant_id)),
  )
  for (const pair of pairing.pairs) {
    const saved = await saveNuvemshopVariantMapping(ctx.companyId, product.id, pair.variationId, remoteId, pair.remoteVariantId)
    if (!saved.ok) return failed(product.id, 'db_error', saved.error, { productName: product.name, remoteProductId: remoteId })
  }
  const variantsMapped = validRows.length + pairing.pairs.length

  if (pairing.unmatched.length > 0) {
    return {
      status: 'inconsistent', productId: product.id, productName: product.name, remoteProductId: remoteId, variantsMapped,
      unmatched: pairing.unmatched,
      message: `Produto já existe na Nuvemshop (ID ${remoteId}), mas ${pairing.unmatched.length} variação(ões) não têm variante remota com o mesmo SKU. Nada foi criado.`,
    }
  }
  return { status: 'relinked', productId: product.id, productName: product.name, remoteProductId: remoteId, variantsMapped }
}

/**
 * Trava em memória contra clique duplo NO MESMO processo (sem schema). Não
 * protege entre instâncias/containers diferentes — ali vale a guarda por SKU.
 */
const publishInFlight = new Set<string>()

/**
 * Publica (ou verifica/repara) um produto da empresa do contexto na loja do
 * contexto. Nunca lança — erros viram `status: 'failed'`.
 */
export async function publishProductToNuvemshop(ctx: NuvemshopContext, productId: number): Promise<PublishResult> {
  const key = `${ctx.companyId}:${productId}`
  if (publishInFlight.has(key)) {
    return failed(productId, 'publish_in_progress', 'Este produto já está sendo enviado para a Nuvemshop. Aguarde o término.')
  }
  publishInFlight.add(key)
  try {
    return await publishProductInner(ctx, productId)
  } finally {
    publishInFlight.delete(key)
  }
}

async function publishProductInner(ctx: NuvemshopContext, productId: number): Promise<PublishResult> {
  const loaded = await loadProduct(ctx.companyId, productId)
  if (loaded.error) return failed(productId, 'db_error', loaded.error)
  const { product, variations } = loaded
  if (!product) return failed(productId, 'not_found', 'Produto não encontrado nesta empresa.')
  if (!product.active) return failed(productId, 'inactive', 'Produto inativo.', { productName: product.name })
  if (variations.length === 0) return failed(productId, 'no_active_variations', 'Produto sem variações ativas.', { productName: product.name })

  const skuIssues = validateErpSkus(variations.map((v) => ({ variationId: v.id, sku: v.sku_variation })))
  if (skuIssues.length > 0) {
    return failed(productId, 'invalid_sku', 'Variações com SKU ausente ou duplicado — corrija o SKU antes de publicar.', { productName: product.name, skuIssues })
  }

  // ── Vínculo existente: verificar na Nuvemshop ─────────────────────────────
  const mapping = await getNuvemshopProductMapping(ctx.companyId, productId)
  if (!mapping.ok) return failed(productId, 'db_error', mapping.error, { productName: product.name })

  let previousRemoteProductId: string | undefined
  if (mapping.data) {
    const live: NuvemshopProductResponse[] = []
    for (const remoteId of distinctRemoteIds(mapping.data)) {
      let remote: NuvemshopProductResponse | null
      try {
        remote = await getNuvemshopProduct(remoteId, ctx.credentials)
      } catch (err) {
        return failed(productId, 'remote_error', `Não foi possível verificar o produto remoto ${remoteId}: ${errorMessage(err)}`, { productName: product.name, remoteProductId: remoteId })
      }
      if (remote) { live.push(remote); continue }
      const inv = await invalidateNuvemshopProductMapping(ctx.companyId, productId, { expectedRemoteProductId: remoteId, reason: 'publish_remote_product_missing' })
      if (!inv.ok) return failed(productId, 'db_error', inv.error, { productName: product.name })
      previousRemoteProductId = remoteId
    }

    if (live.length > 1) {
      return {
        status: 'inconsistent', productId, productName: product.name,
        message: `Produto vinculado a mais de um produto remoto existente (${live.map((r) => r.id).join(', ')}). Nada foi alterado.`,
      }
    }
    if (live.length === 1) {
      const fresh = await getNuvemshopProductMapping(ctx.companyId, productId)
      if (!fresh.ok) return failed(productId, 'db_error', fresh.error, { productName: product.name })
      return repairExistingPublication(ctx, product, variations, fresh.data ?? { productId, remoteProductId: String(live[0].id), productRow: null, variantRows: [] }, live[0])
    }
  }

  // ── Validação local da criação (antes de qualquer chamada remota nova) ────
  const prices = new Map<number, number>()
  const badPrices: number[] = []
  for (const v of variations) {
    const price = resolveVariationPrice(v.price_override, product.base_price)
    if (price == null) badPrices.push(v.id)
    else prices.set(v.id, price)
  }
  if (badPrices.length > 0) {
    return failed(productId, 'invalid_price',
      `Preço inválido (vazio, negativo ou não numérico) na(s) variação(ões) ${badPrices.map((id) => `#${id}`).join(', ')}. Corrija o preço antes de publicar.`,
      { productName: product.name, previousRemoteProductId })
  }

  const loadedPictures = await loadProductPicturesProductFirst(ctx.companyId, productId, variations.map((v) => v.id))
  if (!loadedPictures.ok) {
    return failed(productId, 'db_error', `Falha ao carregar imagens do produto — nada foi criado na Nuvemshop: ${loadedPictures.error}`,
      { productName: product.name, previousRemoteProductId })
  }
  const pictureCheck = validatePublicPictures(loadedPictures.data, NUVEMSHOP_IMAGE_EXTENSIONS)
  if (pictureCheck.valid.length === 0) {
    const detail = pictureCheck.invalid.length > 0 ? ` Ignoradas: ${pictureCheck.invalid.map((i) => i.reason).join('; ')}.` : ''
    return failed(productId, 'no_images',
      `Adicione pelo menos uma imagem pública (JPG, PNG, GIF ou WEBP) ao produto antes de enviá-lo para a Nuvemshop.${detail}`,
      { productName: product.name, previousRemoteProductId })
  }
  const pictures: OrderedProductPicture[] = pictureCheck.valid
  const initialPictures = pictures.slice(0, NUVEMSHOP_INITIAL_IMAGE_LIMIT)
  const extraPictures = pictures.slice(NUVEMSHOP_INITIAL_IMAGE_LIMIT)

  // ── Anti-duplicação: SKU já existe na loja sem vínculo? ───────────────────
  const firstSku = (variations[0].sku_variation ?? '').trim()
  try {
    const bySku = await getNuvemshopProductBySku(firstSku, ctx.credentials)
    if (bySku) {
      return failed(productId, 'remote_sku_conflict',
        `Já existe produto na Nuvemshop (ID ${bySku.id}) com o SKU ${firstSku}, sem vínculo com este produto. Verifique na Nuvemshop antes de publicar — nada foi criado.`,
        { productName: product.name, remoteProductId: String(bySku.id), previousRemoteProductId })
    }
  } catch (err) {
    return failed(productId, 'remote_error', `Falha ao consultar SKU na Nuvemshop: ${errorMessage(err)}`, { productName: product.name, previousRemoteProductId })
  }

  // ── Criação ───────────────────────────────────────────────────────────────
  const stock = await loadStockByVariation(variations.map((v) => v.id))
  if (!stock.ok) {
    return failed(productId, 'db_error', `Falha ao carregar estoque — publicação abortada, nada foi criado na Nuvemshop: ${stock.error}`,
      { productName: product.name, previousRemoteProductId })
  }
  const payload = buildPayload(product, variations, stock.data, prices,
    initialPictures.map((p) => ({ src: p.url, position: p.position })))
  const stockTotal = payload.variants.reduce((sum, v) => sum + v.stock, 0)

  let created: NuvemshopProductResponse
  try {
    created = await createNuvemshopProductFull(payload, ctx.credentials)
  } catch (err) {
    // Sem resposta (timeout/rede): a Nuvemshop PODE ter criado. Não repetimos
    // aqui; a próxima tentativa passa pela guarda por SKU e nunca duplica.
    const message = err instanceof NuvemshopTransportError
      ? `A Nuvemshop não confirmou a criação (${errorMessage(err)}). O produto pode ter sido criado: verifique na Nuvemshop — uma nova tentativa não duplica (confere o SKU antes).`
      : `Falha ao criar produto na Nuvemshop: ${errorMessage(err)}`
    return failed(productId, 'remote_error', message, { productName: product.name, previousRemoteProductId })
  }
  const remoteProductId = String(created.id)

  const savedProduct = await saveNuvemshopProductMapping(ctx.companyId, productId, remoteProductId)
  if (!savedProduct.ok) {
    await logNuvemshopEvent({
      eventType: 'product_publish', direction: 'erp_to_ns', success: false, externalProductId: remoteProductId,
      errorMessage: `Produto criado na Nuvemshop mas mapping não gravado: ${savedProduct.error}`,
      metadata: { company_id: ctx.companyId, produto_id: productId },
    })
    return failed(productId, 'mapping_persist_failed',
      `Produto criado na Nuvemshop (ID ${remoteProductId}), mas o vínculo não foi gravado: ${savedProduct.error}`,
      { productName: product.name, remoteProductId, previousRemoteProductId })
  }

  const pairing = pairVariantsBySku(variations.map((v) => ({ variationId: v.id, sku: v.sku_variation })), created.variants ?? [])
  let variantsMapped = 0
  const persistErrors: string[] = []
  for (const pair of pairing.pairs) {
    const saved = await saveNuvemshopVariantMapping(ctx.companyId, productId, pair.variationId, remoteProductId, pair.remoteVariantId)
    if (saved.ok) variantsMapped++
    else persistErrors.push(`variação #${pair.variationId}: ${saved.error}`)
  }

  // ── Imagens além do limite inicial (produto e vínculo já gravados) ────────
  const imageErrors: string[] = []
  let initialRejected = 0
  if (Array.isArray(created.images) && created.images.length < initialPictures.length) {
    initialRejected = initialPictures.length - created.images.length
    imageErrors.push(`${initialRejected} imagem(ns) do envio inicial não foram aceitas pela Nuvemshop`)
  }
  let sentAfter = 0
  for (const picture of extraPictures) {
    try {
      await addNuvemshopProductImage(remoteProductId, { src: picture.url, position: picture.position }, ctx.credentials)
      sentAfter++
    } catch (err) {
      imageErrors.push(`imagem ${picture.position}: ${errorMessage(err)}`)
    }
  }
  const images: PublishImageReport = {
    found:          loadedPictures.data.length,
    sentInitial:    initialPictures.length,
    sentAfter,
    failed:         initialRejected + (extraPictures.length - sentAfter),
    skippedInvalid: pictureCheck.invalid,
  }
  const warnings: string[] = []
  if (images.failed > 0) {
    warnings.push(`Produto criado, mas ${images.failed} de ${pictures.length} imagem(ns) não foram enviadas à Nuvemshop. Adicione as restantes pelo painel da Nuvemshop.`)
  }
  if (images.skippedInvalid.length > 0) {
    warnings.push(`${images.skippedInvalid.length} imagem(ns) ignoradas por formato/URL não aceitos.`)
  }

  const complete = pairing.unmatched.length === 0 && persistErrors.length === 0
  const problems = [...pairing.unmatched.map((u) => `variação #${u.variationId}: ${u.reason}`), ...persistErrors, ...imageErrors]
  await logNuvemshopEvent({
    eventType: 'product_publish', direction: 'erp_to_ns', success: complete && images.failed === 0, externalProductId: remoteProductId,
    errorMessage: problems.length > 0 ? problems.join('; ') : null,
    metadata: {
      company_id: ctx.companyId, produto_id: productId, previous_remote_product_id: previousRemoteProductId ?? null,
      variations: variations.length, variants_mapped: variantsMapped,
      images_found: images.found, images_sent_initial: images.sentInitial, images_sent_after: images.sentAfter,
      images_failed: images.failed, images_skipped_invalid: images.skippedInvalid.length,
      result: complete ? (images.failed > 0 ? 'published_partial_images' : 'published') : 'inconsistent',
    },
  })

  if (!complete) {
    return {
      status: 'inconsistent', productId, productName: product.name, remoteProductId, previousRemoteProductId, variantsMapped, stockTotal,
      unmatched: pairing.unmatched, images, warnings,
      message: `Produto criado (ID ${remoteProductId}), mas ${pairing.unmatched.length + persistErrors.length} variação(ões) ficaram sem vínculo. Publicar novamente tenta reparar por SKU sem duplicar.`,
    }
  }
  return {
    status: 'published', productId, productName: product.name, remoteProductId, previousRemoteProductId, variantsMapped, stockTotal,
    images, ...(warnings.length > 0 ? { warnings } : {}),
  }
}
