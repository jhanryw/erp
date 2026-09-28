/**
 * ChannelAdapter da Shopee — Fase 3: produto SIMPLES (1 item, sem model /
 * tier_variation). Implementa validateListing, publishListing e
 * fetchListing. As demais operações do contrato lançam
 * ShopeeError('not_implemented') de propósito (fases 5/8) — nunca simulam
 * sucesso.
 *
 * Idempotência NÃO é tratada aqui: o core (listings.service) já reserva a
 * publicação com lease (rpc_begin/complete/fail_channel_listing_publish).
 * publishListing chama add_item UMA vez; timeout/5xx/resposta ambígua sobem
 * como erro e o core deixa o vínculo em estado reconciliável.
 */

import type {
  ChannelAdapter,
  ChannelListingDraft,
  ChannelListingRef,
  ChannelListingSnapshot,
  ChannelValidationResult,
} from '@/lib/channels/types'
import { SHOPEE_PATHS } from './config'
import { ShopeeError, isShopeeError } from './errors'
import { shopeeResponseBody, shopeeShopRequest, type ShopeeRequestDeps, type ShopeeShopContext } from './client'
import type { FetchLike } from './http'
import {
  MAX_ITEM_IMAGES,
  buildAddItemBody,
  readShopeeOptions,
  snapshotFromItem,
  toValidationResult,
  validateAgainstRequirements,
  validateDraftLocally,
  type ResolvedShopeeChoices,
} from './listingPayload'
import { loadRequirementsSnapshot } from './requirements'

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png' }
const DOWNLOAD_TIMEOUT_MS = 20_000

export interface DownloadedImage {
  bytes: Uint8Array<ArrayBuffer>
  contentType: string
  filename: string
}

export type ImageDownloader = (url: string) => Promise<DownloadedImage>

export interface ShopeeAdapterOptions {
  integrationId: number
  companyId: number
  shopId: string
  deps?: ShopeeRequestDeps & { downloadImage?: ImageDownloader }
}

/** Download server-side da URL PÚBLICA do Media Hub (nada é gravado no banco). */
export function createImageDownloader(fetchImpl: FetchLike = globalThis.fetch as FetchLike): ImageDownloader {
  return async (url) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    try {
      let res: Response
      try {
        res = await fetchImpl(url, { method: 'GET', signal: controller.signal })
      } catch {
        throw new ShopeeError('network', 'Falha ao baixar imagem do Media Hub.', { nothingCreated: true })
      }
      if (!res.ok) throw new ShopeeError('bad_request', `Imagem do Media Hub indisponível (HTTP ${res.status}).`, { nothingCreated: true })
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      const ext = IMAGE_TYPES[contentType]
      if (!ext) throw new ShopeeError('bad_request', `Formato de imagem não aceito pela Shopee (${contentType || '?'}).`, { nothingCreated: true })
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw new ShopeeError('bad_request', 'Imagem acima de 10 MB.', { nothingCreated: true })
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new ShopeeError('bad_request', 'Imagem vazia ou acima de 10 MB.', { nothingCreated: true })
      return { bytes, contentType, filename: `image.${ext}` }
    } finally {
      clearTimeout(timer)
    }
  }
}

function notImplemented(op: string): never {
  throw new ShopeeError('not_implemented', `Shopee: ${op} ainda não implementado nesta fase.`)
}

export function createShopeeAdapter(opts: ShopeeAdapterOptions): ChannelAdapter {
  const ctx: ShopeeShopContext = { integrationId: opts.integrationId, companyId: opts.companyId, shopId: opts.shopId, deps: opts.deps }
  const download = opts.deps?.downloadImage ?? createImageDownloader(opts.deps?.fetchImpl)

  async function validate(draft: ChannelListingDraft): Promise<{ result: ChannelValidationResult; choices: ResolvedShopeeChoices | null }> {
    const local = validateDraftLocally(draft)
    if (local.some((e) => e.code === 'invalid_category')) return { result: toValidationResult(local), choices: null }
    let snap
    try {
      snap = await loadRequirementsSnapshot(ctx, Number(draft.categoryId))
    } catch (err) {
      if (isShopeeError(err) && err.kind === 'not_found') {
        return { result: toValidationResult([...local, { code: 'invalid_category', message: err.message }]), choices: null }
      }
      throw err
    }
    const remote = validateAgainstRequirements(draft, snap)
    return { result: toValidationResult([...local, ...remote.errors], remote.warnings), choices: remote.resolved }
  }

  /** Upload de cada URL UMA vez por chamada (idempotência local da tentativa). */
  async function uploadImages(urls: string[]): Promise<{ imageIds: string[]; warnings: string[] }> {
    const cache = new Map<string, string>()
    const warnings: string[] = []
    const unique = [...new Set(urls)]
    if (unique.length > MAX_ITEM_IMAGES) warnings.push(`Só as primeiras ${MAX_ITEM_IMAGES} imagens foram enviadas.`)
    for (const url of unique.slice(0, MAX_ITEM_IMAGES)) {
      if (cache.has(url)) continue
      const img = await download(url)
      const form = new FormData()
      form.append('image', new Blob([img.bytes], { type: img.contentType }), img.filename)
      form.append('scene', 'normal')
      let data: unknown
      try {
        data = (await shopeeShopRequest(ctx, { method: 'POST', path: SHOPEE_PATHS.uploadImage, form, timeoutMs: 30_000 })).data
      } catch (err) {
        // Antes do add_item: nenhum item foi criado, qualquer que seja o erro.
        const e = isShopeeError(err) ? err : new ShopeeError('network', 'Falha no upload de imagem.')
        throw new ShopeeError(e.kind, `Upload de imagem na Shopee falhou: ${e.message}`, { httpStatus: e.httpStatus, shopeeError: e.shopeeError, requestId: e.requestId, retryAfterSeconds: e.retryAfterSeconds, nothingCreated: true })
      }
      const r = (data as { response?: Record<string, unknown> })?.response ?? {}
      const info = (r.image_info as { image_id?: unknown } | undefined)
        ?? ((r.image_info_list as Array<{ image_info?: { image_id?: unknown } }> | undefined)?.[0]?.image_info)
      const id = typeof info?.image_id === 'string' && info.image_id.trim() ? info.image_id.trim() : null
      if (!id) throw new ShopeeError('invalid_response', 'upload_image sem image_id.', { nothingCreated: true })
      cache.set(url, id)
    }
    return { imageIds: unique.slice(0, MAX_ITEM_IMAGES).map((u) => cache.get(u)!), warnings }
  }

  async function fetchOne(itemId: string): Promise<ChannelListingSnapshot> {
    if (!/^\d{1,20}$/.test(itemId)) throw new ShopeeError('bad_request', 'item_id inválido.')
    const res = await shopeeShopRequest(ctx, { method: 'GET', path: SHOPEE_PATHS.getItemBaseInfo, query: { item_id_list: itemId } })
    const r = shopeeResponseBody(res.data, SHOPEE_PATHS.getItemBaseInfo)
    const list = Array.isArray(r.item_list) ? (r.item_list as Array<Record<string, unknown>>) : []
    const item = list.find((i) => String(i?.item_id) === itemId)
    if (!item) throw new ShopeeError('not_found', `Item ${itemId} não encontrado nesta loja Shopee.`)
    const snap = snapshotFromItem(item, opts.shopId)
    if (snap.sellerId !== opts.shopId) {
      throw new ShopeeError('forbidden', `Item ${itemId} pertence a outra loja (${snap.sellerId}), não a ${opts.shopId}.`)
    }
    return snap
  }

  return {
    provider: 'shopee',

    async validateListing(draft) {
      return (await validate(draft)).result
    },

    async publishListing(draft) {
      // Revalida com os requisitos vivos (o core já chamou validateListing;
      // aqui é a fonte das escolhas resolvidas — marca "No Brand", canal logístico).
      let validated: Awaited<ReturnType<typeof validate>>
      try {
        validated = await validate(draft)
      } catch (err) {
        const e = isShopeeError(err) ? err : new ShopeeError('network', 'Falha ao consultar requisitos da Shopee.')
        throw new ShopeeError(e.kind, e.message, { httpStatus: e.httpStatus, shopeeError: e.shopeeError, requestId: e.requestId, retryAfterSeconds: e.retryAfterSeconds, nothingCreated: true })
      }
      const { result, choices } = validated
      if (!result.ok || !choices) {
        throw new ShopeeError('bad_request', `Reprovado na validação Shopee: ${result.errors.map((e) => `${e.code}: ${e.message}`).join(' | ')}`, { nothingCreated: true })
      }
      const { imageIds, warnings } = await uploadImages(draft.pictureUrls)
      const body = buildAddItemBody(draft, { imageIds, choices })

      // add_item UMA vez. Erro explícito da Shopee (HTTP 4xx / campo error) →
      // bad_request (rejeição definitiva); 5xx/timeout/rede → ambíguo.
      const res = await shopeeShopRequest(ctx, { method: 'POST', path: SHOPEE_PATHS.addItem, body, timeoutMs: 30_000 })
      const r = (res.data as { response?: Record<string, unknown>; warning?: unknown })
      const created = r.response && typeof r.response === 'object' ? r.response : null
      const itemId = created?.item_id != null ? String(created.item_id) : ''
      if (!/^\d{1,20}$/.test(itemId) || itemId === '0') {
        // 200 sem item_id: não dá para afirmar que nada foi criado.
        throw new ShopeeError('invalid_response', 'add_item respondeu sem item_id — confira na Shopee antes de republicar.')
      }
      if (typeof r.warning === 'string' && r.warning.trim()) warnings.push(r.warning.trim())

      const base = snapshotFromItem({ ...created, item_sku: created!.item_sku ?? draft.sellerSku }, opts.shopId, { quantity: draft.quantity, sellerSku: draft.sellerSku })

      // Confirmação pós-publicação (get_item_base_info).
      let confirmed: ChannelListingSnapshot | null = null
      try {
        confirmed = await fetchOne(itemId)
      } catch (err) {
        if (isShopeeError(err) && err.kind === 'forbidden') {
          // O item FOI criado: não é rejeição definitiva (invalid_response mantém o vínculo em 'error').
          throw new ShopeeError('invalid_response', `Item ${itemId} criado, mas a confirmação indica outra loja — vínculo NÃO aceito; reconcilie manualmente.`)
        }
        // Consistência eventual / falha transitória: mantém o id do add_item com aviso.
        warnings.push(`Item ${itemId} criado; confirmação pendente (${isShopeeError(err) ? err.kind : 'erro'}).`)
      }
      if (confirmed && confirmed.sellerSku && confirmed.sellerSku !== draft.sellerSku) {
        throw new ShopeeError('invalid_response', `Item ${itemId} criado com SKU divergente (${confirmed.sellerSku} ≠ ${draft.sellerSku}) — reconcilie manualmente.`)
      }
      const snap = confirmed ?? base
      return {
        ...snap,
        externalCategoryId: snap.externalCategoryId ?? String(draft.categoryId),
        quantity: snap.quantity ?? draft.quantity,
        price: snap.price ?? draft.price,
        externalIds: { ...snap.externalIds, image_ids: imageIds, logistic_id: choices.logisticChannelId, condition: readShopeeOptions(draft).condition ?? null },
        warnings: [...warnings, ...snap.warnings],
      }
    },

    async fetchListing(ref: ChannelListingRef) {
      return fetchOne(ref.externalListingId)
    },

    async updateListing() { return notImplemented('updateListing') },
    async updatePrice() { return notImplemented('updatePrice (Fase futura)') },
    async updateQuantity() { return notImplemented('updateQuantity (Fase 5 — stockFanout)') },
    async pauseListing() { return notImplemented('pauseListing') },
    async activateListing() { return notImplemented('activateListing') },
    async findListingsBySellerSku() { return notImplemented('findListingsBySellerSku (Fase 8 — reconciliação); reconcilie manualmente') },
  }
}
