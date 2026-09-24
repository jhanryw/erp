/**
 * stock.changed → canais. Único ponto que leva mudanças de estoque do core
 * aos marketplaces; importadores de pedido NUNCA empurram estoque.
 *
 *   1. core: rpc_process_stock_availability_changes recalcula a
 *      disponibilidade (kits dependentes incluídos) e, na MESMA transação,
 *      marca channel_listings.stock_sync_pending dos anúncios afetados;
 *   2. Nuvemshop: variações alteradas → push de estoque (serviço existente);
 *   3. Marketplace Hub: anúncios pendentes → quantidade ABSOLUTA atual
 *      (syncListing quantityOnly). A marca é limpa ANTES do envio e
 *      restaurada se falhar — mudança nova durante o envio remarca e
 *      nunca se perde.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { processStockAvailabilityChanges } from '@/services/inventory/availability.service'
import { pushMultipleVariantStocksToNuvemshop } from '@/lib/services/nuvemshopSyncService'
import { syncListing, type ListingsServiceDeps } from './listings.service'

export interface PendingListing {
  id: number
  company_id: number
}

export interface StockFanoutDeps {
  processAvailability?: (limit: number, workerId: string) => Promise<{ ok: boolean; changedVariationIds: number[]; error?: string }>
  pushNuvemshop?: (variationIds: number[]) => Promise<void>
  listPending?: (limit: number) => Promise<PendingListing[]>
  setPending?: (listingId: number, pending: boolean) => Promise<void>
  syncQuantity?: (companyId: number, listingId: number) => Promise<void>
  listingsDeps?: ListingsServiceDeps
}

export interface StockFanoutResult {
  changedVariations: number
  nuvemshopPushed: number
  listingsSynced: number
  listingsFailed: number
  errors: string[]
}

export async function runStockChannelFanout(workerId: string, limit = 200, deps: StockFanoutDeps = {}): Promise<StockFanoutResult> {
  const d = {
    processAvailability: deps.processAvailability ?? defaultProcessAvailability,
    pushNuvemshop: deps.pushNuvemshop ?? ((ids: number[]) => pushMultipleVariantStocksToNuvemshop(ids, { eventType: 'stock_push_erp' })),
    listPending: deps.listPending ?? defaultListPending,
    setPending: deps.setPending ?? defaultSetPending,
    syncQuantity: deps.syncQuantity ?? (async (companyId: number, listingId: number) => { await syncListing(companyId, listingId, deps.listingsDeps, { quantityOnly: true }) }),
  }
  const result: StockFanoutResult = { changedVariations: 0, nuvemshopPushed: 0, listingsSynced: 0, listingsFailed: 0, errors: [] }

  const avail = await d.processAvailability(Math.max(limit, 1) * 5, workerId)
  if (!avail.ok) result.errors.push(`disponibilidade: ${avail.error ?? 'falhou'}`)
  result.changedVariations = avail.changedVariationIds.length

  if (avail.changedVariationIds.length > 0) {
    try {
      await d.pushNuvemshop(avail.changedVariationIds)
      result.nuvemshopPushed = avail.changedVariationIds.length
    } catch (err) {
      result.errors.push(`nuvemshop: ${err instanceof Error ? err.message : 'erro'}`)
    }
  }

  for (const l of await d.listPending(limit)) {
    await d.setPending(l.id, false)
    try {
      await d.syncQuantity(l.company_id, l.id)
      result.listingsSynced++
    } catch (err) {
      await d.setPending(l.id, true)
      result.listingsFailed++
      result.errors.push(`anúncio ${l.id}: ${err instanceof Error ? err.message : 'erro'}`)
    }
  }
  return result
}

async function defaultProcessAvailability(limit: number, workerId: string) {
  const res = await processStockAvailabilityChanges(limit, workerId)
  if (!res.ok) return { ok: false, changedVariationIds: [], error: res.error }
  return { ok: true, changedVariationIds: (res.data.changed_variation_ids ?? []).map(Number) }
}

async function defaultListPending(limit: number): Promise<PendingListing[]> {
  const admin = createAdminClient() as any
  const { data, error } = await admin.from('channel_listings')
    .select('id, company_id')
    .eq('stock_sync_pending', true)
    .order('updated_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error(error.message)
  return data ?? []
}

async function defaultSetPending(listingId: number, pending: boolean): Promise<void> {
  const admin = createAdminClient() as any
  const { error } = await admin.from('channel_listings').update({ stock_sync_pending: pending }).eq('id', listingId)
  if (error) throw new Error(error.message)
}
