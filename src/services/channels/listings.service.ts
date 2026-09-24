/**
 * Marketplace Hub — serviço GENÉRICO de anúncios (channel_listings).
 *
 * Fala com canais só via ChannelAdapter (src/lib/channels/types.ts). Regras
 * do core que valem para QUALQUER canal:
 *
 *   - Quantidade = camada central de disponibilidade (getVariationAvailability,
 *     modo 'online_priority'): produto normal → saldo físico; kit →
 *     derivada dos componentes. Nenhum `if kit` aqui; nenhum stock_balances.
 *     Sempre ABSOLUTA.
 *   - Habilitação manual do Qarvon (produto/variação ativos) é soberana:
 *     desativada → não publica; na sincronização envia quantidade 0 (o canal
 *     trata como sem estoque) e NUNCA reativa uma pausa manual.
 *   - SKU = sku_variation da variação vendável (kit: SKU do kit).
 *   - Preço = channel_price (preço do canal) ?? price_override ?? base_price.
 *   - company_id SEMPRE da sessão; tudo filtrado por ele (backend + RPC + trigger).
 *   - Publicação idempotente: lease em channel_listings ('publishing') antes
 *     de chamar o canal; queda no meio → reconciliação por SKU, nunca
 *     republicação cega.
 */

import { randomUUID } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  resolveLocalStatus,
  type ChannelAdapter,
  type ChannelAttributeValue,
  type ChannelListingDraft,
  type ChannelListingSnapshot,
  type ListingLocalStatus,
} from '@/lib/channels/types'
import { isMercadoLivreError } from '@/lib/integrations/mercadolivre/errors'
import { logMercadoLivre, type MercadoLivreEvent, type MercadoLivreLogFields } from '@/lib/integrations/mercadolivre/log'
import { validatePictureUrls } from '@/lib/integrations/mercadolivre/listingPayload'
import { getVariationAvailability } from '@/services/inventory/availability.service'
import { listMediaByEntity } from '@/services/media.service'
import { createMercadoLivreAdapter } from '@/lib/integrations/mercadolivre/adapter'
import { resolveMercadoLivreChannel } from './mercadolivreChannel'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type ListingErrorCode =
  | 'not_connected' | 'needs_reauth' | 'not_found' | 'manual_disabled' | 'invalid_images'
  | 'missing_attributes' | 'invalid_price' | 'already_published' | 'in_progress'
  | 'needs_reconciliation' | 'not_published' | 'channel_error' | 'real_account_blocked' | 'validation_failed'

export class ListingError extends Error {
  constructor(readonly code: ListingErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ListingError'
  }
}

export interface ChannelContext {
  provider: 'mercadolivre'
  integrationId: number
  companyId: number
  sellerId: string
  siteId: string
  currencyId: string
  /** Modelo de publicação do canal (ML: user_products | legacy). */
  model: string
  accountLabel: string | null
  isTestAccount: boolean
}

export interface ListingRow {
  id: number
  company_id: number
  integration_id: number
  provider: string
  product_id: number
  product_variation_id: number
  seller_sku: string
  /** Chave estável da oferta dentro da variação (1 variação → N anúncios). */
  offer_key: string
  listing_type_id: string | null
  external_listing_id: string | null
  external_variant_id: string | null
  external_product_id: string | null
  external_group_id: string | null
  external_ids: Record<string, unknown>
  external_category_id: string | null
  external_status: string | null
  external_sub_status: string[] | null
  permalink: string | null
  local_status: ListingLocalStatus
  channel_price: number | null
  last_sent_price: number | null
  synced_quantity: number | null
  last_synced_at: string | null
  last_error: string | null
  publish_lease_until: string | null
  metadata: Record<string, unknown>
}

export type BeginResult =
  | { result: 'claimed'; listing_id: number }
  | { result: 'already_published' | 'in_progress' | 'needs_reconciliation'; listing_id?: number }

export interface ListingsRepo {
  begin(args: {
    companyId: number; integrationId: number; provider: string; productId: number; productVariationId: number
    sellerSku: string; attemptId: string; leaseSeconds: number; channelPrice: number | null
    metadata: Record<string, unknown>; userId: string; offerKey: string; listingTypeId: string | null
  }): Promise<BeginResult>
  complete(companyId: number, listingId: number, attemptId: string | null, snap: ChannelListingSnapshot,
    sentPrice: number | null, quantity: number | null, warning: string | null): Promise<boolean>
  fail(companyId: number, listingId: number, attemptId: string | null, error: string): Promise<boolean>
  get(companyId: number, listingId: number): Promise<ListingRow | null>
  listByProduct(companyId: number, productId: number): Promise<ListingRow[]>
  update(companyId: number, listingId: number, patch: Partial<ListingRow>): Promise<void>
}

export interface VariationSource {
  id: number
  sku: string
  price_override: number | null
  active: boolean
  color: string | null
  size: string | null
}

export interface ProductSource {
  id: number
  name: string
  base_price: number
  active: boolean
  brand: string | null
  model: string | null
  is_kit: boolean
  variations: VariationSource[]
}

export interface ListingSourceLoader {
  loadProduct(companyId: number, productId: number): Promise<ProductSource | null>
  /** URLs de imagem já em ordem (variação primeiro, depois produto). */
  loadPictures(companyId: number, productId: number, variationId: number): Promise<string[]>
}

export interface AvailabilityInfo {
  sellable_quantity: number
  manual_enabled: boolean
}

export interface ListingsServiceDeps {
  repo?: ListingsRepo
  source?: ListingSourceLoader
  availability?: (companyId: number, variationIds: number[]) => Promise<Map<number, AvailabilityInfo>>
  resolveChannel?: (companyId: number) => Promise<ChannelContext>
  adapterFor?: (ctx: ChannelContext) => ChannelAdapter
  leaseSeconds?: number
}

export interface PublishVariationInput {
  productVariationId: number
  /** Preço específico do canal (null/ausente = herda o preço do Qarvon). */
  channelPrice?: number | null
  attributes?: ChannelAttributeValue[]
}

export interface PublishInput {
  productId: number
  categoryId: string
  /** Domínio do canal (ML: domain_id do preditor) — guardado p/ tabela de medidas e retry. */
  domainId?: string | null
  listingTypeId?: string
  /**
   * Oferta dentro da variação (idempotência): a mesma variação pode ter N
   * anúncios no mesmo canal (ex.: Clássico + Premium). Padrão = tipo de anúncio.
   */
  offerKey?: string | null
  /** Nome genérico (ML UP: family_name). Padrão: nome do produto. */
  familyName?: string | null
  description?: string | null
  commonAttributes?: ChannelAttributeValue[]
  variations: PublishVariationInput[]
  /** Ids de atributos obrigatórios da categoria (validados antes de chamar o canal). */
  requiredAttributeIds?: string[]
}

export type PublishOutcome =
  | { productVariationId: number; status: 'published' | 'reconciled'; listingId: number; externalListingId: string; warnings: string[] }
  | { productVariationId: number; status: 'skipped'; reason: ListingErrorCode; message: string; listingId?: number }
  | { productVariationId: number; status: 'failed'; reason: ListingErrorCode; message: string; listingId?: number }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OFFER_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/

/** Chave da oferta: informada (slug) ou o tipo de anúncio; 'default' em último caso. */
export function normalizeOfferKey(offerKey: string | null | undefined, listingTypeId: string | null | undefined): string {
  const raw = (offerKey ?? '').trim().toLowerCase() || (listingTypeId ?? '').trim().toLowerCase() || 'default'
  const key = raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '').slice(0, 60)
  if (!OFFER_KEY_RE.test(key)) throw new ListingError('invalid_price', 'Identificador da oferta inválido (use letras, números, - e _).')
  return key
}

export const CURRENCY_BY_SITE: Readonly<Record<string, string>> = {
  MLB: 'BRL', MLA: 'ARS', MLM: 'MXN', MLC: 'CLP', MCO: 'COP', MLU: 'UYU', MPE: 'PEN',
}

export function resolveListingPrice(product: { base_price: number }, variation: { price_override: number | null }, channelPrice: number | null | undefined): number {
  const price = channelPrice ?? variation.price_override ?? product.base_price
  return Math.round(Number(price) * 100) / 100
}

/** Quantidade a enviar: vendável se habilitado manualmente; senão 0 (nunca negativo). */
export function resolveListingQuantity(info: AvailabilityInfo | undefined): number {
  if (!info || !info.manual_enabled) return 0
  return Math.max(0, Math.floor(info.sellable_quantity))
}

function mergeAttributes(common: ChannelAttributeValue[] = [], specific: ChannelAttributeValue[] = []): ChannelAttributeValue[] {
  const byId = new Map<string, ChannelAttributeValue>()
  for (const a of [...common, ...specific]) if (a?.id) byId.set(a.id.toUpperCase(), { ...a, id: a.id.toUpperCase() })
  return [...byId.values()]
}

function errorText(err: unknown): string {
  if (err instanceof ListingError) return err.message
  if (isMercadoLivreError(err)) return `${err.kind}${err.httpStatus ? ` (${err.httpStatus})` : ''}: ${err.message}`
  return err instanceof Error ? err.message : 'erro inesperado'
}

/** Etapa em que a tentativa de publicação parou (auditoria + decisão de retry). */
export type AttemptStage = 'validate' | 'create_rejected' | 'create_unknown' | 'reconcile'

export interface AttemptRecord {
  at: string
  stage: AttemptStage
  error: string
  price: number | null
  quantity: number | null
  category_id: string | null
}

const MAX_ATTEMPT_HISTORY = 10

/**
 * Registra a tentativa em metadata (last_attempt + attempts[]) e decide o
 * estado local: se é CERTO que nada foi criado no canal → 'draft'
 * (republicável); se é incerto → mantém 'error' (exige reconciliação).
 */
async function recordAttempt(
  repo: ListingsRepo, companyId: number, listingId: number, attempt: AttemptRecord, nothingCreated: boolean,
): Promise<void> {
  const row = await repo.get(companyId, listingId)
  if (!row) return
  const meta = (row.metadata ?? {}) as Record<string, unknown>
  const history = Array.isArray(meta.attempts) ? (meta.attempts as AttemptRecord[]) : []
  await repo.update(companyId, listingId, {
    ...(nothingCreated && !row.external_listing_id && row.local_status === 'error' ? { local_status: 'draft' as const } : {}),
    metadata: { ...meta, last_attempt: attempt, attempts: [...history, attempt].slice(-MAX_ATTEMPT_HISTORY) },
  })
}

/** Falha no POST /items que garante que o anúncio NÃO foi criado (rejeição explícita do canal). */
function isDefinitiveRejection(err: unknown): boolean {
  return isMercadoLivreError(err) && ['bad_request', 'forbidden', 'unauthorized', 'reauth_required', 'not_found'].includes(err.kind)
}

function channelLog(ctx: Pick<ChannelContext, 'provider' | 'companyId' | 'integrationId'>, event: string, fields: MercadoLivreLogFields = {}): void {
  if (ctx.provider === 'mercadolivre') {
    logMercadoLivre(`mercadolivre.listing.${event}` as MercadoLivreEvent, { company_id: ctx.companyId, integration_id: ctx.integrationId, ...fields })
  }
}

function resolveDeps(deps: ListingsServiceDeps = {}) {
  return {
    repo: deps.repo ?? createSupabaseListingsRepo(),
    source: deps.source ?? createSupabaseListingSource(),
    availability: deps.availability ?? defaultAvailability,
    resolveChannel: deps.resolveChannel ?? defaultResolveChannel,
    adapterFor: deps.adapterFor ?? defaultAdapterFor,
    leaseSeconds: deps.leaseSeconds ?? 120,
  }
}

// ─── Publicação ───────────────────────────────────────────────────────────────

/**
 * Trava de homologação: só cria anúncios em conta de TESTE do canal até a
 * liberação explícita (CHANNEL_LISTINGS_ALLOW_REAL_ACCOUNTS=true). Evita
 * publicar na conta real da loja durante a Fase 2. Sincronizar/pausar
 * anúncios já existentes não é afetado.
 */
export function assertPublishAllowed(ctx: Pick<ChannelContext, 'isTestAccount'>, env: Record<string, string | undefined> = process.env): void {
  if (ctx.isTestAccount) return
  if (env.CHANNEL_LISTINGS_ALLOW_REAL_ACCOUNTS === 'true') return
  throw new ListingError('real_account_blocked', 'Publicação em conta REAL bloqueada nesta fase: conecte um usuário de TESTE do Mercado Livre.')
}

export async function publishListings(
  session: { companyId: number; userId: string },
  input: PublishInput,
  deps?: ListingsServiceDeps,
): Promise<{ channel: ChannelContext; results: PublishOutcome[] }> {
  const d = resolveDeps(deps)
  const ctx = await d.resolveChannel(session.companyId)
  assertPublishAllowed(ctx)
  // Oferta resolvida uma vez para o pedido inteiro (mesma chave em todas as variações).
  const listingTypeId = input.listingTypeId ?? 'gold_special'
  input = { ...input, listingTypeId, offerKey: normalizeOfferKey(input.offerKey, listingTypeId) }
  const product = await d.source.loadProduct(session.companyId, input.productId)
  if (!product) throw new ListingError('not_found', 'Produto não encontrado.')

  const wanted = new Map(input.variations.map((v) => [v.productVariationId, v]))
  const variations = product.variations.filter((v) => wanted.has(v.id))
  const unknown = [...wanted.keys()].filter((id) => !variations.some((v) => v.id === id))

  const availability = await d.availability(session.companyId, variations.map((v) => v.id))
  const adapter = d.adapterFor(ctx)
  const results: PublishOutcome[] = unknown.map((id) => ({
    productVariationId: id, status: 'failed', reason: 'not_found', message: 'Variação não pertence a este produto/empresa.',
  }))

  for (const variation of variations) {
    results.push(await publishOne(d, ctx, adapter, session, product, variation, wanted.get(variation.id)!, input, availability.get(variation.id)))
  }
  return { channel: ctx, results }
}

async function publishOne(
  d: ReturnType<typeof resolveDeps>,
  ctx: ChannelContext,
  adapter: ChannelAdapter,
  session: { companyId: number; userId: string },
  product: ProductSource,
  variation: VariationSource,
  vInput: PublishVariationInput,
  input: PublishInput,
  info: AvailabilityInfo | undefined,
): Promise<PublishOutcome> {
  const pvid = variation.id
  const fail = (reason: ListingErrorCode, message: string, listingId?: number): PublishOutcome =>
    ({ productVariationId: pvid, status: 'failed', reason, message, listingId })

  // Habilitação manual é soberana: não publica o que o usuário desativou.
  if (!product.active || !variation.active || info?.manual_enabled === false) {
    return { productVariationId: pvid, status: 'skipped', reason: 'manual_disabled', message: 'Produto/variação desativado no Qarvon.' }
  }

  const price = resolveListingPrice(product, variation, vInput.channelPrice)
  if (!(price > 0)) return fail('invalid_price', 'Preço inválido.')

  const pictures = validatePictureUrls(await d.source.loadPictures(session.companyId, product.id, pvid))
  if (pictures.valid.length === 0) {
    return fail('invalid_images', `Nenhuma imagem válida (JPG/PNG pública).${pictures.invalid.length ? ` Recusadas: ${pictures.invalid.map((i) => i.reason).join('; ')}` : ''}`)
  }

  const attributes = mergeAttributes(input.commonAttributes, vInput.attributes)
  const filled = new Set(attributes.filter((a) => (a.value_id ?? '').toString().trim() || (a.value_name ?? '').toString().trim()).map((a) => a.id))
  const missing = (input.requiredAttributeIds ?? [])
    .map((id) => id.toUpperCase())
    .filter((id) => id !== 'SELLER_SKU' && !filled.has(id) && !(id === 'GTIN' && filled.has('EMPTY_GTIN_REASON')))
  if (missing.length > 0) return fail('missing_attributes', `Atributos obrigatórios sem valor: ${missing.join(', ')}.`)

  const quantity = resolveListingQuantity(info)
  const productName = (input.familyName?.trim() || product.name)
  const titleParts = [productName, variation.color, variation.size].filter(Boolean)
  const draft: ChannelListingDraft = {
    sellerSku: variation.sku,
    productName,
    title: titleParts.join(' '),
    description: input.description ?? null,
    categoryId: input.categoryId,
    price,
    currencyId: ctx.currencyId,
    quantity,
    pictureUrls: pictures.valid,
    attributes,
    channelOptions: { listing_type_id: input.listingTypeId!, condition: 'new' },
  }

  // Vínculo em 'error' sem id externo = a tentativa anterior PODE ter criado o
  // anúncio (timeout/5xx no POST). Nunca republica às cegas: reconcilia por SKU
  // antes (vincula se achar; se não achar, a linha volta a 'draft' e segue).
  const existing = (await d.repo.listByProduct(session.companyId, product.id))
    .find((r) => r.product_variation_id === pvid && r.integration_id === ctx.integrationId
      && r.offer_key === input.offerKey && r.local_status !== 'closed')
  if (existing && !existing.external_listing_id && existing.local_status === 'error') {
    const rec = await reconcileListing(session.companyId, existing.id, { ...d, resolveChannel: async () => ctx, adapterFor: () => adapter })
    if (rec.outcome === 'attached') {
      return { productVariationId: pvid, status: 'reconciled', listingId: existing.id, externalListingId: rec.externalListingId!, warnings: [] }
    }
    if (rec.outcome !== 'not_found') return fail('needs_reconciliation', rec.message, existing.id)
  }

  const attemptId = randomUUID()
  const begin = await d.repo.begin({
    companyId: session.companyId, integrationId: ctx.integrationId, provider: ctx.provider,
    productId: product.id, productVariationId: pvid, sellerSku: variation.sku, attemptId,
    leaseSeconds: d.leaseSeconds, channelPrice: vInput.channelPrice ?? null,
    metadata: {
      category_id: input.categoryId, domain_id: input.domainId ?? null, listing_type_id: draft.channelOptions.listing_type_id, family_name: productName,
      description: input.description ?? null, attributes, model: ctx.model, offer_key: input.offerKey,
    },
    userId: session.userId,
    offerKey: input.offerKey!,
    listingTypeId: input.listingTypeId ?? null,
  })

  if (begin.result === 'already_published') {
    return { productVariationId: pvid, status: 'skipped', reason: 'already_published', message: `Variação já tem a oferta "${input.offerKey}" neste canal.`, listingId: begin.listing_id }
  }
  if (begin.result === 'in_progress') {
    return { productVariationId: pvid, status: 'skipped', reason: 'in_progress', message: 'Publicação desta variação já está em andamento.', listingId: begin.listing_id }
  }
  if (begin.result === 'needs_reconciliation') {
    // Tentativa anterior caiu entre a criação no canal e o salvamento:
    // procura pelo SKU antes de qualquer nova tentativa (nunca duplica).
    const rec = await reconcileListing(session.companyId, begin.listing_id!, { ...d, resolveChannel: async () => ctx, adapterFor: () => adapter })
    if (rec.outcome === 'attached') {
      return { productVariationId: pvid, status: 'reconciled', listingId: begin.listing_id!, externalListingId: rec.externalListingId!, warnings: [] }
    }
    return fail('needs_reconciliation', rec.message, begin.listing_id)
  }

  if (begin.result !== 'claimed') return fail('channel_error', `Resultado de reserva inesperado: ${begin.result}`)
  const listingId = begin.listing_id
  channelLog(ctx, 'publish_started', { listing_id: listingId, product_variation_id: pvid, quantity })
  let stage: 'validate' | 'create' = 'validate'
  const attemptOf = (st: AttemptStage, error: string): AttemptRecord => ({
    at: new Date().toISOString(), stage: st, error, price, quantity, category_id: input.categoryId,
  })
  try {
    // Validação no canal ANTES de criar (ML: POST /items/validate). Erro → nada é publicado.
    const validationWarnings: string[] = []
    if (adapter.validateListing) {
      const v = await adapter.validateListing(draft)
      validationWarnings.push(...v.warnings.map((w) => w.message))
      if (!v.ok) {
        const message = `Reprovado na validação do canal: ${v.errors.map((e) => (e.code ? `${e.code}: ${e.message}` : e.message)).join(' | ')}`
        if (await d.repo.fail(session.companyId, listingId, attemptId, message)) {
          await recordAttempt(d.repo, session.companyId, listingId, attemptOf('validate', message), true)
        }
        channelLog(ctx, 'publish_failed', { listing_id: listingId, product_variation_id: pvid, reason: 'validation_failed' })
        return fail('validation_failed', message, listingId)
      }
    }
    stage = 'create'
    const snap = await adapter.publishListing(draft)
    snap.warnings = [...validationWarnings, ...snap.warnings]
    const warning = snap.warnings.length ? `aviso: ${snap.warnings.join(' | ')}` : null
    const saved = await d.repo.complete(session.companyId, listingId, attemptId, snap, price, quantity, warning)
    if (!saved) {
      // Lease perdido: o anúncio EXISTE no canal; a reconciliação vincula.
      channelLog(ctx, 'publish_failed', { listing_id: listingId, product_variation_id: pvid, external_listing_id: snap.externalListingId, reason: 'lease_lost' })
      return fail('needs_reconciliation', `Anúncio ${snap.externalListingId} criado, mas o vínculo precisa ser reconciliado.`, listingId)
    }
    channelLog(ctx, 'published', { listing_id: listingId, product_variation_id: pvid, external_listing_id: snap.externalListingId, quantity })
    return { productVariationId: pvid, status: 'published', listingId, externalListingId: snap.externalListingId, warnings: snap.warnings }
  } catch (err) {
    const message = errorText(err)
    // Antes do POST /items (validação) ou rejeição explícita do POST: nada foi
    // criado → republicável. Timeout/5xx/rede no POST: pode ter sido criado →
    // continua 'error' e exige reconciliação por SKU.
    const nothingCreated = stage === 'validate' || isDefinitiveRejection(err)
    if (await d.repo.fail(session.companyId, listingId, attemptId, message)) {
      await recordAttempt(d.repo, session.companyId, listingId,
        attemptOf(stage === 'validate' ? 'validate' : nothingCreated ? 'create_rejected' : 'create_unknown', message), nothingCreated)
    }
    channelLog(ctx, 'publish_failed', {
      listing_id: listingId, product_variation_id: pvid,
      http_status: isMercadoLivreError(err) ? err.httpStatus : null,
      reason: isMercadoLivreError(err) ? err.kind : 'error',
    })
    return fail(isMercadoLivreError(err) && err.kind === 'reauth_required' ? 'needs_reauth' : 'channel_error', message, listingId)
  }
}

// ─── Sincronização / pausa / ativação ────────────────────────────────────────

async function loadPublished(d: ReturnType<typeof resolveDeps>, companyId: number, listingId: number): Promise<ListingRow> {
  const row = await d.repo.get(companyId, listingId)
  if (!row) throw new ListingError('not_found', 'Anúncio não encontrado.')
  if (!row.external_listing_id) throw new ListingError('not_published', 'Anúncio ainda não publicado (sem id externo).')
  return row
}

function refOf(row: ListingRow) {
  return { externalListingId: row.external_listing_id!, externalVariantId: row.external_variant_id, externalProductId: row.external_product_id }
}

function snapshotPatch(row: ListingRow, snap: ChannelListingSnapshot, localStatus?: ListingLocalStatus): Partial<ListingRow> {
  return {
    external_status: snap.externalStatus,
    external_sub_status: snap.externalSubStatus,
    permalink: snap.permalink ?? row.permalink,
    external_product_id: snap.externalProductId ?? row.external_product_id,
    external_group_id: snap.externalGroupId ?? row.external_group_id,
    external_ids: { ...(row.external_ids ?? {}), ...snap.externalIds },
    local_status: localStatus ?? resolveLocalStatus(row.local_status, snap.externalStatus, snap.externalSubStatus),
  }
}

/**
 * Sincronização manual: envia quantidade ABSOLUTA atual (camada central) e,
 * se mudou, o preço. Nunca altera a pausa manual.
 */
export async function syncListing(
  companyId: number,
  listingId: number,
  deps?: ListingsServiceDeps,
  options: { quantityOnly?: boolean } = {},
): Promise<ListingRow> {
  const d = resolveDeps(deps)
  const row = await loadPublished(d, companyId, listingId)
  const ctx = await d.resolveChannel(companyId)
  if (row.integration_id !== ctx.integrationId) throw new ListingError('not_connected', 'Anúncio pertence a uma conta que não está mais conectada.')
  const adapter = d.adapterFor(ctx)

  const product = await d.source.loadProduct(companyId, row.product_id)
  const variation = product?.variations.find((v) => v.id === row.product_variation_id)
  if (!product || !variation) throw new ListingError('not_found', 'Produto/variação do anúncio não encontrado.')

  const info = (await d.availability(companyId, [row.product_variation_id])).get(row.product_variation_id)
  const quantity = product.active && variation.active ? resolveListingQuantity(info) : 0
  const price = resolveListingPrice(product, variation, row.channel_price)
  const warnings: string[] = []

  try {
    let snap = await adapter.updateQuantity(refOf(row), quantity)
    warnings.push(...snap.warnings)
    let sentPrice = row.last_sent_price
    // quantityOnly: fan-out de estoque (stock.changed) — nunca mexe em preço.
    if (!options.quantityOnly && (row.last_sent_price == null || Math.abs(Number(row.last_sent_price) - price) > 0.009)) {
      snap = await adapter.updatePrice(refOf(row), price)
      warnings.push(...snap.warnings)
      sentPrice = snap.price != null && Math.abs(snap.price - price) <= 0.009 ? price : row.last_sent_price
    }
    await d.repo.update(companyId, listingId, {
      ...snapshotPatch(row, snap),
      synced_quantity: quantity,
      last_sent_price: sentPrice,
      last_synced_at: new Date().toISOString(),
      last_error: warnings.length ? `aviso: ${[...new Set(warnings)].join(' | ')}` : null,
    })
    channelLog(ctx, 'synced', { listing_id: listingId, external_listing_id: row.external_listing_id, quantity })
  } catch (err) {
    await d.repo.update(companyId, listingId, { last_error: errorText(err) })
    channelLog(ctx, 'sync_failed', { listing_id: listingId, external_listing_id: row.external_listing_id, reason: isMercadoLivreError(err) ? err.kind : 'error' })
    throw err
  }
  return (await d.repo.get(companyId, listingId))!
}

export async function pauseListing(companyId: number, listingId: number, deps?: ListingsServiceDeps): Promise<ListingRow> {
  const d = resolveDeps(deps)
  const row = await loadPublished(d, companyId, listingId)
  const ctx = await d.resolveChannel(companyId)
  const snap = await d.adapterFor(ctx).pauseListing(refOf(row))
  await d.repo.update(companyId, listingId, { ...snapshotPatch(row, snap, 'paused'), last_error: null })
  channelLog(ctx, 'paused', { listing_id: listingId, external_listing_id: row.external_listing_id })
  return (await d.repo.get(companyId, listingId))!
}

/**
 * Reativa uma pausa MANUAL. Bloqueado se o produto/variação estiver
 * desativado no Qarvon (a habilitação manual do Qarvon prevalece).
 */
export async function activateListing(companyId: number, listingId: number, deps?: ListingsServiceDeps): Promise<ListingRow> {
  const d = resolveDeps(deps)
  const row = await loadPublished(d, companyId, listingId)
  const ctx = await d.resolveChannel(companyId)
  const product = await d.source.loadProduct(companyId, row.product_id)
  const variation = product?.variations.find((v) => v.id === row.product_variation_id)
  if (!product || !variation || !product.active || !variation.active) {
    throw new ListingError('manual_disabled', 'Reative o produto/variação no Qarvon antes de reativar o anúncio.')
  }
  const snap = await d.adapterFor(ctx).activateListing(refOf(row))
  // Sem estoque o canal pode manter pausado por out_of_stock — isso NÃO é pausa manual.
  await d.repo.update(companyId, listingId, { ...snapshotPatch(row, snap, 'active'), last_error: null })
  channelLog(ctx, 'activated', { listing_id: listingId, external_listing_id: row.external_listing_id })
  return (await d.repo.get(companyId, listingId))!
}

// ─── Reconciliação ────────────────────────────────────────────────────────────

export interface ReconcileResult {
  outcome: 'attached' | 'not_found' | 'ambiguous' | 'nothing_to_do'
  externalListingId?: string
  message: string
}

/**
 * Para vínculos presos em 'publishing' (lease vencido) ou 'error' sem id
 * externo: procura no canal pelo seller_sku. 1 resultado → vincula; 0 →
 * libera para nova publicação; >1 → não escolhe sozinho (manual).
 */
export async function reconcileListing(companyId: number, listingId: number, deps?: ListingsServiceDeps): Promise<ReconcileResult> {
  const d = resolveDeps(deps)
  const row = await d.repo.get(companyId, listingId)
  if (!row) throw new ListingError('not_found', 'Anúncio não encontrado.')
  if (row.external_listing_id) return { outcome: 'nothing_to_do', externalListingId: row.external_listing_id, message: 'Anúncio já vinculado.' }
  if (row.local_status === 'publishing' && row.publish_lease_until && new Date(row.publish_lease_until).getTime() > Date.now()) {
    throw new ListingError('in_progress', 'Publicação em andamento; aguarde antes de reconciliar.')
  }

  const ctx = await d.resolveChannel(companyId)
  const found = await d.adapterFor(ctx).findListingsBySellerSku(row.seller_sku)
  const alreadyLinked = new Set((await d.repo.listByProduct(companyId, row.product_id)).map((r) => r.external_listing_id).filter(Boolean))
  let candidates = found.filter((s) => !alreadyLinked.has(s.externalListingId) && s.externalStatus !== 'closed')
  // Multi-oferta: o mesmo SKU pode ter N anúncios (Clássico, Premium…).
  // Desempata pela condição comercial e categoria DESTA oferta — nunca escolhe no chute.
  if (candidates.length > 1) {
    const wantedType = row.listing_type_id ?? ((row.metadata ?? {}) as Record<string, unknown>).listing_type_id ?? null
    const wantedCategory = ((row.metadata ?? {}) as Record<string, unknown>).category_id ?? null
    const narrowed = candidates.filter((c) =>
      (wantedType == null || c.listingTypeId == null || c.listingTypeId === wantedType)
      && (wantedCategory == null || c.externalCategoryId == null || c.externalCategoryId === wantedCategory))
    if (narrowed.length >= 1) candidates = narrowed
  }

  if (candidates.length === 1) {
    const snap = candidates[0]
    await d.repo.complete(companyId, listingId, null, snap, snap.price, snap.quantity, 'aviso: vinculado por reconciliação (SKU)')
    channelLog(ctx, 'reconciled', { listing_id: listingId, external_listing_id: snap.externalListingId, reason: 'attached' })
    return { outcome: 'attached', externalListingId: snap.externalListingId, message: `Vinculado ao anúncio ${snap.externalListingId}.` }
  }
  if (candidates.length === 0) {
    // Nada no canal com este SKU: o vínculo volta a ser republicável ('draft')
    // na MESMA linha (preserva idempotência). Ids externos são limpos; o erro
    // anterior fica em metadata.last_attempt/attempts para auditoria.
    const note = 'Reconciliação: nenhum anúncio com este SKU no canal — pode publicar novamente.'
    if (row.local_status === 'publishing') {
      const released = await d.repo.fail(companyId, listingId, null, note) // só com lease vencido (fencing)
      if (!released) throw new ListingError('in_progress', 'Publicação em andamento; aguarde antes de reconciliar.')
    }
    const meta = (row.metadata ?? {}) as Record<string, unknown>
    const history = Array.isArray(meta.attempts) ? (meta.attempts as AttemptRecord[]) : []
    const rec: AttemptRecord = { at: new Date().toISOString(), stage: 'reconcile', error: note, price: null, quantity: null, category_id: null }
    await d.repo.update(companyId, listingId, {
      local_status: 'draft',
      external_listing_id: null, external_variant_id: null, external_product_id: null, external_group_id: null,
      external_ids: {}, external_status: null, external_sub_status: null, permalink: null,
      publish_lease_until: null,
      last_error: note,
      metadata: {
        ...meta,
        // last_attempt continua sendo a última tentativa de PUBLICAÇÃO (o erro original)
        last_attempt: meta.last_attempt ?? (row.last_error ? { ...rec, stage: 'create_unknown', error: row.last_error } : undefined),
        attempts: [...history, rec].slice(-MAX_ATTEMPT_HISTORY),
        reconcile_candidates: undefined,
      },
    })
    channelLog(ctx, 'reconciled', { listing_id: listingId, reason: 'not_found' })
    return { outcome: 'not_found', message: 'Nenhum anúncio com este SKU no canal; a variação pode ser publicada novamente.' }
  }
  const ids = candidates.map((c) => c.externalListingId)
  await d.repo.update(companyId, listingId, {
    last_error: `Reconciliação: ${ids.length} anúncios com o mesmo SKU (${ids.join(', ')}) — vincule manualmente.`,
    metadata: { ...(row.metadata ?? {}), reconcile_candidates: ids },
  })
  channelLog(ctx, 'reconciled', { listing_id: listingId, reason: 'ambiguous' })
  return { outcome: 'ambiguous', message: `Mais de um anúncio com o SKU ${row.seller_sku}: ${ids.join(', ')}.` }
}

// ─── Leitura para a UI ───────────────────────────────────────────────────────

export interface ListingView {
  id: number
  product_variation_id: number
  seller_sku: string
  offer_key: string
  listing_type_id: string | null
  local_status: ListingLocalStatus
  external_status: string | null
  external_sub_status: string[]
  external_listing_id: string | null
  external_product_id: string | null
  external_group_id: string | null
  permalink: string | null
  price: number | null
  channel_price: number | null
  synced_quantity: number | null
  last_synced_at: string | null
  last_error: string | null
  /** Sem id externo e sem risco de duplicar: UI mostra "Publicar novamente". */
  can_publish: boolean
  /** Sem id externo, mas a última tentativa pode ter criado o anúncio: UI mostra "Reconciliar". */
  needs_reconciliation: boolean
  /** Última tentativa de publicação (histórico; nunca bloqueia nova tentativa). */
  last_attempt: { at: string; stage: string; error: string; price: number | null } | null
  /** Dados usados na última tentativa, para pré-preencher o formulário. */
  previous_input: {
    category_id: string | null
    domain_id: string | null
    family_name: string | null
    description: string | null
    listing_type_id: string | null
    attributes: ChannelAttributeValue[]
  } | null
}

export function toListingView(row: ListingRow): ListingView {
  const meta = (row.metadata ?? {}) as Record<string, unknown>
  const la = meta.last_attempt as AttemptRecord | undefined
  const unlinked = !row.external_listing_id
  const leaseAlive = row.local_status === 'publishing' && row.publish_lease_until != null && new Date(row.publish_lease_until).getTime() > Date.now()
  return {
    id: row.id,
    product_variation_id: row.product_variation_id,
    seller_sku: row.seller_sku,
    offer_key: row.offer_key,
    listing_type_id: row.listing_type_id ?? ((row.metadata ?? {}) as Record<string, unknown>).listing_type_id as string ?? null,
    local_status: row.local_status,
    external_status: row.external_status,
    external_sub_status: row.external_sub_status ?? [],
    external_listing_id: row.external_listing_id,
    external_product_id: row.external_product_id,
    external_group_id: row.external_group_id,
    permalink: row.permalink,
    price: row.last_sent_price,
    channel_price: row.channel_price,
    synced_quantity: row.synced_quantity,
    last_synced_at: row.last_synced_at,
    last_error: row.last_error,
    can_publish: unlinked && row.local_status === 'draft',
    needs_reconciliation: unlinked && (row.local_status === 'error' || (row.local_status === 'publishing' && !leaseAlive)),
    last_attempt: la ? { at: la.at, stage: la.stage, error: la.error, price: la.price ?? null } : null,
    previous_input: meta.category_id
      ? {
          category_id: (meta.category_id as string) ?? null,
          domain_id: (meta.domain_id as string) ?? null,
          family_name: (meta.family_name as string) ?? null,
          description: (meta.description as string) ?? null,
          listing_type_id: (meta.listing_type_id as string) ?? null,
          attributes: Array.isArray(meta.attributes) ? (meta.attributes as ChannelAttributeValue[]) : [],
        }
      : null,
  }
}

export interface ChannelOfferView extends ListingView {
  /** Preço efetivo desta oferta (preço do canal ?? preço do Qarvon). */
  effective_price: number
  /** O que mudou desde a última tentativa que falhou (o erro exibido é histórico). */
  attempt_outdated: string[]
}

export interface ChannelProductOverview {
  variations: Array<{
    id: number
    sku: string
    color: string | null
    size: string | null
    is_kit: boolean
    manual_enabled: boolean
    price: number
    sellable_quantity: number
    picture_count: number
    picture_problems: string[]
    /** TODAS as ofertas vivas da variação neste canal (1 variação → N anúncios). */
    listings: ChannelOfferView[]
  }>
  product: { id: number; name: string; brand: string | null; model: string | null; is_kit: boolean }
}

/** Visão do produto para a seção "Canais de venda" (sem nada sensível). */
function outdatedReasons(listing: ListingRow | undefined, currentPrice: number, info: AvailabilityInfo | undefined): string[] {
  if (!listing || listing.external_listing_id) return []
  const la = (listing.metadata as Record<string, unknown> | null)?.last_attempt as AttemptRecord | undefined
  if (!la) return []
  const reasons: string[] = []
  if (la.price != null && Math.abs(Number(la.price) - currentPrice) > 0.009) reasons.push(`preço mudou (${la.price} → ${currentPrice})`)
  const qty = resolveListingQuantity(info)
  if (la.quantity != null && la.quantity !== qty) reasons.push(`quantidade mudou (${la.quantity} → ${qty})`)
  return reasons
}

export async function getChannelProductOverview(companyId: number, productId: number, deps?: ListingsServiceDeps): Promise<ChannelProductOverview> {
  const d = resolveDeps(deps)
  const product = await d.source.loadProduct(companyId, productId)
  if (!product) throw new ListingError('not_found', 'Produto não encontrado.')
  const [availability, listings] = await Promise.all([
    d.availability(companyId, product.variations.map((v) => v.id)),
    d.repo.listByProduct(companyId, productId),
  ])
  const live = listings.filter((l) => l.local_status !== 'closed')

  const variations = await Promise.all(product.variations.map(async (v) => {
    const pics = validatePictureUrls(await d.source.loadPictures(companyId, product.id, v.id))
    const info = availability.get(v.id)
    const offers: ChannelOfferView[] = live
      .filter((l) => l.product_variation_id === v.id)
      .sort((a, b) => a.id - b.id)
      .map((l) => {
        const effective = resolveListingPrice(product, v, l.channel_price)
        return { ...toListingView(l), effective_price: effective, attempt_outdated: outdatedReasons(l, effective, info) }
      })
    return {
      id: v.id,
      sku: v.sku,
      color: v.color,
      size: v.size,
      is_kit: product.is_kit,
      manual_enabled: product.active && v.active && info?.manual_enabled !== false,
      price: resolveListingPrice(product, v, null),
      sellable_quantity: info?.sellable_quantity ?? 0,
      picture_count: pics.valid.length,
      picture_problems: pics.invalid.map((i) => i.reason),
      listings: offers,
    }
  }))
  return { product: { id: product.id, name: product.name, brand: product.brand, model: product.model, is_kit: product.is_kit }, variations }
}

// ─── Implementações de produção ──────────────────────────────────────────────

async function defaultAvailability(companyId: number, variationIds: number[]): Promise<Map<number, AvailabilityInfo>> {
  const res = await getVariationAvailability(companyId, variationIds, 'online_priority')
  if (!res.ok) throw new ListingError('channel_error', `Falha ao calcular disponibilidade: ${res.error}`)
  const out = new Map<number, AvailabilityInfo>()
  for (const [id, a] of res.data) out.set(id, { sellable_quantity: a.sellable_quantity, manual_enabled: a.manual_enabled })
  return out
}

async function defaultResolveChannel(companyId: number): Promise<ChannelContext> {
  return resolveMercadoLivreChannel(companyId)
}

/** Registro de adaptadores por provider — único ponto que conhece as implementações. */
function defaultAdapterFor(ctx: ChannelContext): ChannelAdapter {
  return createMercadoLivreAdapter({
    integrationId: ctx.integrationId, companyId: ctx.companyId, sellerId: ctx.sellerId,
    model: ctx.model === 'user_products' ? 'user_products' : 'legacy',
  })
}

const LISTING_COLUMNS = `id, company_id, integration_id, provider, product_id, product_variation_id, seller_sku, offer_key, listing_type_id,
  external_listing_id, external_variant_id, external_product_id, external_group_id, external_ids,
  external_category_id, external_status, external_sub_status, permalink, local_status, channel_price,
  last_sent_price, synced_quantity, last_synced_at, last_error, publish_lease_until, metadata`

export function createSupabaseListingsRepo(): ListingsRepo {
  const admin = createAdminClient() as any
  return {
    async begin(a) {
      const { data, error } = await admin.rpc('rpc_begin_channel_listing_publish', {
        p_company_id: a.companyId, p_integration_id: a.integrationId, p_provider: a.provider,
        p_product_id: a.productId, p_product_variation_id: a.productVariationId, p_seller_sku: a.sellerSku,
        p_attempt_id: a.attemptId, p_lease_seconds: a.leaseSeconds, p_channel_price: a.channelPrice,
        p_metadata: a.metadata, p_user_id: a.userId, p_offer_key: a.offerKey, p_listing_type_id: a.listingTypeId,
      })
      if (error) throw new ListingError('channel_error', `Falha ao reservar publicação: ${error.message}`)
      return data as BeginResult
    },
    async complete(companyId, listingId, attemptId, snap, sentPrice, quantity, warning) {
      const { data, error } = await admin.rpc('rpc_complete_channel_listing_publish', {
        p_company_id: companyId, p_listing_id: listingId, p_attempt_id: attemptId,
        p_external_listing_id: snap.externalListingId, p_external_variant_id: snap.externalVariantId,
        p_external_product_id: snap.externalProductId, p_external_group_id: snap.externalGroupId,
        p_external_ids: snap.externalIds, p_external_category_id: snap.externalCategoryId,
        p_external_status: snap.externalStatus, p_external_sub_status: snap.externalSubStatus,
        p_permalink: snap.permalink, p_sent_price: sentPrice, p_synced_quantity: quantity, p_warning: warning,
      })
      if (error) throw new ListingError('channel_error', `Falha ao salvar vínculo: ${error.message}`)
      return data === true
    },
    async fail(companyId, listingId, attemptId, message) {
      const { data } = await admin.rpc('rpc_fail_channel_listing_publish', {
        p_company_id: companyId, p_listing_id: listingId, p_attempt_id: attemptId, p_error: message,
      })
      return data === true
    },
    async get(companyId, listingId) {
      const { data } = await admin.from('channel_listings').select(LISTING_COLUMNS).eq('id', listingId).eq('company_id', companyId).maybeSingle()
      return (data ?? null) as ListingRow | null
    },
    async listByProduct(companyId, productId) {
      const { data } = await admin.from('channel_listings').select(LISTING_COLUMNS).eq('company_id', companyId).eq('product_id', productId).order('id')
      return (data ?? []) as ListingRow[]
    },
    async update(companyId, listingId, patch) {
      const { error } = await admin.from('channel_listings').update(patch).eq('id', listingId).eq('company_id', companyId)
      if (error) throw new ListingError('channel_error', `Falha ao atualizar anúncio: ${error.message}`)
    },
  }
}

export function createSupabaseListingSource(): ListingSourceLoader {
  const admin = createAdminClient() as any
  return {
    async loadProduct(companyId, productId) {
      const { data: p } = await admin
        .from('products')
        .select('id, name, base_price, active, modelo, product_kind, brands:brand_id ( name )')
        .eq('id', productId)
        .eq('company_id', companyId)
        .maybeSingle()
      if (!p) return null
      const { data: vars } = await admin
        .from('product_variations')
        .select(`id, sku_variation, price_override, active,
          product_variation_attributes ( variation_types:variation_type_id ( slug ), variation_values:variation_value_id ( value ) )`)
        .eq('product_id', productId)
        .order('id')
      const attr = (v: any, slug: string) => (v.product_variation_attributes ?? []).find((a: any) => a.variation_types?.slug === slug)?.variation_values?.value ?? null
      return {
        id: p.id,
        name: p.name,
        base_price: Number(p.base_price),
        active: p.active,
        brand: p.brands?.name ?? null,
        model: p.modelo && !['kit', 'sem_modelo'].includes(p.modelo) ? p.modelo : null,
        is_kit: p.product_kind === 'kit',
        variations: (vars ?? []).map((v: any) => ({
          id: v.id, sku: v.sku_variation, price_override: v.price_override != null ? Number(v.price_override) : null,
          active: v.active, color: attr(v, 'cor'), size: attr(v, 'tamanho'),
        })),
      }
    },
    async loadPictures(companyId, productId, variationId) {
      const pick = (items: Array<{ url: string; visibility: string; active: boolean; url_expires_at: string | null; role: string }>) =>
        items.filter((m) => m.visibility === 'public' && m.active && !m.url_expires_at)
          .sort((a, b) => (a.role === 'primary' ? -1 : 0) - (b.role === 'primary' ? -1 : 0))
          .map((m) => m.url)
      const [vMedia, pMedia] = await Promise.all([
        listMediaByEntity('product_variation', String(variationId), companyId),
        listMediaByEntity('product', String(productId), companyId),
      ])
      const urls = [...(vMedia.ok ? pick(vMedia.data) : []), ...(pMedia.ok ? pick(pMedia.data) : [])]
      if (urls.length === 0) {
        const { data } = await admin.from('products').select('photo_url').eq('id', productId).eq('company_id', companyId).maybeSingle()
        if (data?.photo_url) urls.push(data.photo_url)
      }
      return [...new Set(urls)]
    },
  }
}
