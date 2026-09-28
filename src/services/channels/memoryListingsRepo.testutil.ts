/**
 * Repo em memória com a MESMA semântica das RPCs de channel_listings
 * (202609251000 + 202609260900: reserva por integração × variação × oferta).
 * Só para testes — cópia do double de listings.service.test.ts, exportada
 * para os testes multi-canal (ML + Shopee).
 */

import type { ChannelListingSnapshot } from '@/lib/channels/types'
import type { BeginResult, ListingRow, ListingsRepo } from './listings.service'

/** Repo em memória com a MESMA semântica das RPCs de 202609251000 (coberta em SQL). */
export class MemoryRepo implements ListingsRepo {
  rows: Array<ListingRow & { publish_attempt_id: string | null }> = []
  next = 1
  now = () => Date.now()

  async begin(a: Parameters<ListingsRepo['begin']>[0]): Promise<BeginResult> {
    // Mesma semântica da RPC (202609260900): reserva POR OFERTA (variação × offer_key).
    const r = this.rows.find((x) => x.integration_id === a.integrationId && x.product_variation_id === a.productVariationId
      && x.offer_key === a.offerKey && x.company_id === a.companyId && x.local_status !== 'closed')
    const lease = new Date(this.now() + Math.max(a.leaseSeconds, 10) * 1000).toISOString()
    if (r) {
      if (r.local_status === 'active' || r.local_status === 'paused' || r.external_listing_id) return { result: 'already_published', listing_id: r.id }
      if (r.local_status === 'publishing') {
        return new Date(r.publish_lease_until!).getTime() > this.now() ? { result: 'in_progress', listing_id: r.id } : { result: 'needs_reconciliation', listing_id: r.id }
      }
      Object.assign(r, { local_status: 'publishing', publish_attempt_id: a.attemptId, publish_lease_until: lease, seller_sku: a.sellerSku, channel_price: a.channelPrice, metadata: { ...r.metadata, ...a.metadata }, last_error: null })
      return { result: 'claimed', listing_id: r.id }
    }
    const row = {
      id: this.next++, company_id: a.companyId, integration_id: a.integrationId, provider: a.provider, product_id: a.productId,
      product_variation_id: a.productVariationId, seller_sku: a.sellerSku, offer_key: a.offerKey, listing_type_id: a.listingTypeId,
      external_listing_id: null, external_variant_id: null,
      external_product_id: null, external_group_id: null, external_ids: {}, external_category_id: null, external_status: null,
      external_sub_status: null, permalink: null, local_status: 'publishing' as const, channel_price: a.channelPrice, last_sent_price: null,
      synced_quantity: null, last_synced_at: null, last_error: null, publish_lease_until: lease, publish_attempt_id: a.attemptId, metadata: a.metadata,
    }
    this.rows.push(row)
    return { result: 'claimed', listing_id: row.id }
  }

  async complete(companyId: number, id: number, attemptId: string | null, s: ChannelListingSnapshot, sentPrice: number | null, qty: number | null, warning: string | null) {
    const r = this.rows.find((x) => x.id === id && x.company_id === companyId)
    const expired = !r?.publish_lease_until || new Date(r.publish_lease_until).getTime() < this.now()
    if (!r || !((attemptId && r.publish_attempt_id === attemptId && r.local_status === 'publishing') || (!attemptId && ['publishing', 'error'].includes(r.local_status) && expired))) return false
    Object.assign(r, {
      external_listing_id: s.externalListingId, external_variant_id: s.externalVariantId, external_product_id: s.externalProductId,
      external_group_id: s.externalGroupId, external_ids: { ...r.external_ids, ...s.externalIds }, external_category_id: s.externalCategoryId ?? r.external_category_id,
      external_status: s.externalStatus, external_sub_status: s.externalSubStatus, permalink: s.permalink,
      local_status: s.externalStatus === 'closed' ? 'closed' : 'active', last_sent_price: sentPrice, synced_quantity: qty,
      last_synced_at: new Date().toISOString(), last_error: warning, publish_attempt_id: null, publish_lease_until: null,
    })
    return true
  }

  async fail(companyId: number, id: number, attemptId: string | null, error: string) {
    const r = this.rows.find((x) => x.id === id && x.company_id === companyId)
    const expired = r?.publish_lease_until != null && new Date(r.publish_lease_until).getTime() < this.now()
    if (!r || !((attemptId && r.publish_attempt_id === attemptId && r.local_status === 'publishing') || (!attemptId && r.local_status === 'publishing' && expired))) return false
    Object.assign(r, { local_status: 'error', last_error: error, publish_attempt_id: null, publish_lease_until: null })
    return true
  }

  async get(companyId: number, id: number) { return this.rows.find((x) => x.id === id && x.company_id === companyId) ?? null }
  async listByProduct(companyId: number, productId: number) { return this.rows.filter((x) => x.company_id === companyId && x.product_id === productId) }
  async update(companyId: number, id: number, patch: Partial<ListingRow>) {
    const r = this.rows.find((x) => x.id === id && x.company_id === companyId)
    if (r) Object.assign(r, patch)
  }
}

