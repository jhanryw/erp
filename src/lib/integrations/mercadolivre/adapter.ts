/**
 * MercadoLivreAdapter — implementação de ChannelAdapter para o Mercado Livre.
 * Toda chamada passa por mercadoLivreRequest (token/refresh/erros tipados da
 * Fase 1). Nenhuma lógica de estoque/kit aqui: recebe quantidade ABSOLUTA.
 *
 *   validate    POST /items/validate (204 = ok; 400 com cause[] error/warning — nada é criado)
 *   publish     POST /items (+ POST /items/{id}/description, + GET /user-products/{id} p/ family_id)
 *   fetch       GET  /items/{id}
 *   fetch lote  GET  /items?ids=A,B,…  (multiget, até 20 por chamada; erro por item)
 *   price       PUT  /items/{id} {price}
 *   quantity    PUT  /items/{id} {available_quantity}   (0 → ML pausa com out_of_stock e reativa ao repor)
 *   pause       PUT  /items/{id} {status:'paused'}      (paused_by_seller: nunca reativa sozinho)
 *   activate    PUT  /items/{id} {status:'active'}
 *   reconcile   GET  /users/{seller}/items/search?seller_sku=
 */

import type { ChannelAdapter, ChannelFetchResult, ChannelListingDraft, ChannelListingRef, ChannelListingSnapshot, ChannelValidationResult } from '@/lib/channels/types'
import { mercadoLivreRequest, type MercadoLivreRequestDeps } from './client'
import { MercadoLivreError, isMercadoLivreError, parseMercadoLivreCauses } from './errors'
import { buildItemBody, normalizeAttributes, parseItem, type MercadoLivreListingModel } from './listingPayload'

export interface MercadoLivreAdapterContext {
  integrationId: number
  companyId: number
  sellerId: string
  model: MercadoLivreListingModel
  maxTitleLength?: number
  deps?: MercadoLivreRequestDeps
}

/** Limite documentado do multiget GET /items?ids=. */
const MULTIGET_MAX = 20

export function createMercadoLivreAdapter(ctx: MercadoLivreAdapterContext): ChannelAdapter {
  const call = <T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, query?: Record<string, string>) =>
    mercadoLivreRequest<T>({ integrationId: ctx.integrationId, companyId: ctx.companyId, method, path, body, query, deps: ctx.deps })

  const itemPath = (ref: ChannelListingRef) => `/items/${encodeURIComponent(ref.externalListingId)}`

  async function familyIdOf(userProductId: string | null | undefined): Promise<string | null> {
    if (!userProductId) return null
    try {
      const res = await call<{ family_id?: number | string }>('GET', `/user-products/${encodeURIComponent(userProductId)}`)
      return res.data?.family_id != null ? String(res.data.family_id) : null
    } catch {
      return null // informativo; nunca derruba a operação principal
    }
  }

  async function fetchListing(ref: ChannelListingRef): Promise<ChannelListingSnapshot> {
    const res = await call<Record<string, unknown>>('GET', itemPath(ref))
    return parseItem(res.data)
  }

  async function put(ref: ChannelListingRef, body: Record<string, unknown>): Promise<ChannelListingSnapshot> {
    const res = await call<Record<string, unknown>>('PUT', itemPath(ref), body)
    return parseItem(res.data)
  }

  return {
    provider: 'mercadolivre',

    /**
     * Mesmo corpo do POST /items. Erros de validação (400 com cause[]) viram
     * resultado; falhas de transporte/autenticação continuam sendo exceção
     * (não dá para afirmar que o anúncio é válido nem inválido).
     */
    async validateListing(draft: ChannelListingDraft): Promise<ChannelValidationResult> {
      const body = buildItemBody(draft, ctx.model, ctx.maxTitleLength)
      const pick = (c: { code: string | null; message: string }) => ({ code: c.code, message: c.message })
      try {
        const res = await call<unknown>('POST', '/items/validate', body)
        const causes = parseMercadoLivreCauses(res.data)
        return { ok: true, errors: [], warnings: causes.map(pick) }
      } catch (err) {
        if (!isMercadoLivreError(err) || err.kind !== 'bad_request') throw err
        const errors = err.causes.filter((c) => c.type === 'error').map(pick)
        const warnings = err.causes.filter((c) => c.type === 'warning').map(pick)
        if (errors.length === 0 && warnings.length > 0) return { ok: true, errors: [], warnings }
        return { ok: false, errors: errors.length ? errors : [{ code: err.mlError, message: err.message }], warnings }
      }
    },

    async publishListing(draft: ChannelListingDraft) {
      const body = buildItemBody(draft, ctx.model, ctx.maxTitleLength)
      const created = await call<Record<string, unknown>>('POST', '/items', body)
      const itemId = String(created.data.id)
      const warnings: string[] = []

      if (draft.description?.trim()) {
        try {
          await call('POST', `/items/${encodeURIComponent(itemId)}/description`, { plain_text: draft.description.trim() })
        } catch (err) {
          warnings.push(`descrição não aceita: ${isMercadoLivreError(err) ? err.kind : 'erro'}`)
        }
      }

      const familyId = await familyIdOf(created.data.user_product_id as string | undefined)
      return parseItem(created.data, { familyId, warnings })
    },

    fetchListing,

    async fetchListings(externalListingIds) {
      const out: ChannelFetchResult[] = []
      const ids = [...new Set(externalListingIds)]
      for (let i = 0; i < ids.length; i += MULTIGET_MAX) {
        const chunk = ids.slice(i, i + MULTIGET_MAX)
        const res = await call<Array<{ code?: number; body?: Record<string, unknown> }>>('GET', '/items', undefined, { ids: chunk.join(',') })
        const rows = Array.isArray(res.data) ? res.data : []
        chunk.forEach((id, idx) => {
          // Casamento pelo id do corpo; itens com erro (sem id) pela posição — o ML preserva a ordem de ids.
          const r = rows.find((x) => x?.body?.id != null && String(x.body.id) === id)
            ?? (rows.length === chunk.length && rows[idx]?.code !== 200 ? rows[idx] : undefined)
          if (r && r.code === 200 && r.body) out.push({ externalListingId: id, snapshot: parseItem(r.body), error: null })
          else out.push({ externalListingId: id, snapshot: null, error: { status: r?.code ?? null, message: String((r?.body as Record<string, unknown> | undefined)?.message ?? 'item não retornado pelo canal') } })
        })
      }
      return out
    },

    async updateListing(ref, draft) {
      const body: Record<string, unknown> = {}
      if (draft.pictureUrls) body.pictures = draft.pictureUrls.map((source) => ({ source }))
      if (draft.attributes && draft.sellerSku) body.attributes = normalizeAttributes(draft.attributes, draft.sellerSku)
      if (ctx.model === 'legacy' && draft.title) body.title = draft.title
      if (Object.keys(body).length === 0) return fetchListing(ref)
      return put(ref, body)
    },

    async updatePrice(ref, price) {
      if (!(price > 0)) throw new MercadoLivreError('bad_request', 'Preço precisa ser maior que zero.')
      const snap = await put(ref, { price: Math.round(price * 100) / 100 })
      // Com automação de preço ativa o ML ignora o preço e devolve warning (doc "Preços de produtos").
      if (snap.price != null && Math.abs(snap.price - price) > 0.009) {
        snap.warnings.push(`preço não aplicado pelo Mercado Livre (atual ${snap.price})`)
      }
      return snap
    },

    async updateQuantity(ref, quantity) {
      return put(ref, { available_quantity: Math.max(0, Math.floor(quantity)) })
    },

    async pauseListing(ref) {
      return put(ref, { status: 'paused' })
    },

    async activateListing(ref) {
      return put(ref, { status: 'active' })
    },

    async findListingsBySellerSku(sellerSku) {
      const res = await call<{ results?: string[] }>('GET', `/users/${encodeURIComponent(ctx.sellerId)}/items/search`, undefined, { seller_sku: sellerSku })
      const ids = (res.data?.results ?? []).slice(0, 10)
      const snaps: ChannelListingSnapshot[] = []
      for (const id of ids) {
        const snap = await fetchListing({ externalListingId: id })
        if (snap.sellerSku === sellerSku) {
          snap.externalGroupId = snap.externalGroupId ?? await familyIdOf(snap.externalProductId)
          snaps.push(snap)
        }
      }
      return snaps
    },
  }
}

/** Conta no modelo User Products? (tag `user_product_seller` em /users/me). */
export function listingModelFromTags(tags: string[] | undefined): MercadoLivreListingModel {
  return Array.isArray(tags) && tags.includes('user_product_seller') ? 'user_products' : 'legacy'
}
