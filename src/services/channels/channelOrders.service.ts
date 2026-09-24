/**
 * Pedidos de canal (Marketplace Hub) — orquestração GENÉRICA sobre as RPCs
 * transacionais de 202609261100. Nenhuma regra de estoque/kit/financeiro
 * aqui: isso vive nas RPCs e no core (rpc_create_sale / rpc_cancel_sale).
 *
 *   notificação (inbound_events) → processMercadoLivreOrder:
 *     1. relê o pedido na API (a notificação não é a verdade);
 *     2. normaliza (valores REAIS: order, shipment costs, billing);
 *     3. mapeia itens por channel_listings (item_id → variation_id →
 *        user_product_id → SELLER_SKU) — nunca por nome;
 *     4. grava o snapshot (rpc_upsert_channel_order);
 *     5. age pelo estado do pedido: importar | aguardar pagamento |
 *        cancelar | needs_attention.
 *
 * Empresa/integração vêm SEMPRE do evento (resolvido pelo user_id do ML no
 * banco); o seller do pedido é conferido contra a conta conectada.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { isMercadoLivreError } from '@/lib/integrations/mercadolivre/errors'
import {
  fetchBillingOrder,
  fetchOrder,
  fetchShipment,
  fetchShipmentCosts,
  normalizeMercadoLivreOrder,
  type MlBillingOrder,
  type MlOrder,
  type MlShipment,
  type MlShipmentCosts,
  type NormalizedOrderItem,
  type NormalizedPayment,
} from '@/lib/integrations/mercadolivre/orders'
import type { MercadoLivreRequestDeps } from '@/lib/integrations/mercadolivre/client'

// ─── Tipos / dependências ─────────────────────────────────────────────────────

export interface ChannelIntegrationRow {
  id: number
  company_id: number
  provider: string
  status: string
  external_account_id: string | null
  created_by: string | null
}

export interface ListingForMapping {
  id: number
  product_variation_id: number
  seller_sku: string
  external_listing_id: string | null
  external_variant_id: string | null
  external_product_id: string | null
  local_status: string
}

/**
 * Como a oferta (anúncio) do item foi resolvida — gravado em
 * channel_order_items.listing_resolution para auditoria.
 */
export type ListingResolution = 'exact' | 'user_product_id' | 'seller_sku' | 'ambiguous_same_variation' | 'unmapped' | 'conflict'

export interface MappedOrderItem extends NormalizedOrderItem {
  channel_listing_id: number | null
  product_variation_id: number | null
  mapping_status: 'mapped' | 'unmapped' | 'conflict'
  mapping_note: string | null
  listing_resolution: ListingResolution
}

export interface UpsertResult {
  channel_order_id: number
  processing_state: string
  sale_id: number | null
}

export interface ChannelOrdersRepo {
  getIntegration(companyId: number, integrationId: number): Promise<ChannelIntegrationRow | null>
  findListings(companyId: number, integrationId: number): Promise<ListingForMapping[]>
  upsertOrder(companyId: number, integrationId: number, provider: string, order: Record<string, unknown>, items: MappedOrderItem[]): Promise<UpsertResult>
  setState(companyId: number, channelOrderId: number, state: string, code?: string | null, reason?: string | null): Promise<boolean>
  importOrder(companyId: number, channelOrderId: number, userId: string, payments: NormalizedPayment[]): Promise<Record<string, unknown>>
  syncCosts(companyId: number, channelOrderId: number, userId: string): Promise<Record<string, unknown>>
  cancelOrder(companyId: number, channelOrderId: number, userId: string, reason: string | null): Promise<Record<string, unknown>>
}

export interface MlOrderApi {
  fetchOrder(orderId: string): Promise<MlOrder>
  fetchShipment(shipmentId: string): Promise<MlShipment>
  fetchShipmentCosts(shipmentId: string): Promise<MlShipmentCosts>
  fetchBillingOrder(orderId: string): Promise<MlBillingOrder | null>
}

export interface ChannelOrdersDeps {
  repo?: ChannelOrdersRepo
  apiFor?: (ctx: { integrationId: number; companyId: number }) => MlOrderApi
  mlDeps?: MercadoLivreRequestDeps
}

export class ChannelOrderError extends Error {
  constructor(readonly code: 'integration_not_found' | 'not_found' | 'invalid', message: string) {
    super(message)
    this.name = 'ChannelOrderError'
  }
}

export interface ProcessOrderResult {
  channelOrderId: number | null
  action: 'imported' | 'already_imported' | 'awaiting_payment' | 'cancelled' | 'needs_attention' | 'ignored' | 'costs_synced'
  code?: string | null
  saleId?: number | null
}

// ─── Mapeamento (puro) ────────────────────────────────────────────────────────

/**
 * item do pedido → oferta → variação, SÓ por ids estáveis (nunca por nome/título):
 *
 *   caminho normal:  item_id exato → channel_listing_id → product_variation_id
 *                    (legado com variações: desempata por variation_id)
 *   fallback:        user_product_id, depois SELLER_SKU
 *
 * 1 variação pode ter N ofertas (Clássico, Premium…): se o fallback (ou um
 * item_id legado ambíguo) achar N anúncios que apontam TODOS para a MESMA
 * variação, importa pela variação (não perde venda/estoque) SEM inventar a
 * oferta: channel_listing_id = null e listing_resolution =
 * 'ambiguous_same_variation'. Variações diferentes → conflict.
 *
 * SELLER_SKU é auxiliar: divergência com o vínculo resolvido pelo item_id
 * exato vira AVISO, nunca bloqueio.
 */
export function mapOrderItems(items: NormalizedOrderItem[], listings: ListingForMapping[]): MappedOrderItem[] {
  const live = listings.filter((l) => l.local_status !== 'closed')
  const sameVariation = (c: ListingForMapping[]) => c.length > 0 && c.every((l) => l.product_variation_id === c[0].product_variation_id)

  return items.map((it) => {
    const out = (patch: Pick<MappedOrderItem, 'channel_listing_id' | 'product_variation_id' | 'mapping_status' | 'mapping_note' | 'listing_resolution'>): MappedOrderItem =>
      ({ ...it, ...patch })
    const resolveMany = (c: ListingForMapping[], via: string): MappedOrderItem =>
      sameVariation(c)
        ? out({ channel_listing_id: null, product_variation_id: c[0].product_variation_id, mapping_status: 'mapped',
            listing_resolution: 'ambiguous_same_variation',
            mapping_note: `listing_resolution=ambiguous_same_variation: ${c.length} ofertas da mesma variação por ${via} (anúncios ${c.map((l) => l.id).join(', ')}); oferta exata não identificada.` })
        : out({ channel_listing_id: null, product_variation_id: null, mapping_status: 'conflict', listing_resolution: 'conflict',
            mapping_note: `Ofertas de variações diferentes por ${via} (anúncios ${c.map((l) => l.id).join(', ')}).` })

    // 1. Caminho normal: item_id exato.
    let byItem = live.filter((l) => l.external_listing_id === it.external_item_id)
    if (byItem.length > 1) {
      const byVariant = byItem.filter((l) => (l.external_variant_id ?? null) === (it.external_variation_id ?? null))
      if (byVariant.length) byItem = byVariant
    }
    if (byItem.length === 1) {
      const l = byItem[0]
      const skuWarning = it.seller_sku && l.seller_sku !== it.seller_sku
        ? `aviso: SELLER_SKU do pedido (${it.seller_sku}) ≠ do vínculo (${l.seller_sku}); resolvido pelo item_id exato.`
        : null
      return out({ channel_listing_id: l.id, product_variation_id: l.product_variation_id, mapping_status: 'mapped', listing_resolution: 'exact', mapping_note: skuWarning })
    }
    if (byItem.length > 1) return resolveMany(byItem, 'item_id')

    // 2. Fallbacks (item_id não resolveu a oferta).
    const fallbacks: Array<[ListingResolution, ListingForMapping[]]> = [
      ['user_product_id', it.external_user_product_id ? live.filter((l) => l.external_product_id === it.external_user_product_id) : []],
      ['seller_sku', it.seller_sku ? live.filter((l) => l.seller_sku === it.seller_sku) : []],
    ]
    for (const [via, c] of fallbacks) {
      if (c.length === 1) {
        return out({ channel_listing_id: c[0].id, product_variation_id: c[0].product_variation_id, mapping_status: 'mapped',
          listing_resolution: via, mapping_note: `vinculado por ${via}` })
      }
      if (c.length > 1) return resolveMany(c, via)
    }
    return out({ channel_listing_id: null, product_variation_id: null, mapping_status: 'unmapped', listing_resolution: 'unmapped',
      mapping_note: `Sem vínculo para ${it.external_item_id}${it.seller_sku ? ` / ${it.seller_sku}` : ''}.` })
  })
}

// ─── Orquestração ─────────────────────────────────────────────────────────────

function resolve(deps: ChannelOrdersDeps = {}) {
  return {
    repo: deps.repo ?? createSupabaseChannelOrdersRepo(),
    apiFor: deps.apiFor ?? ((ctx: { integrationId: number; companyId: number }) => defaultApi({ ...ctx, deps: deps.mlDeps })),
  }
}

/** Erros que não mudam repetindo (recurso inexistente/sem permissão). */
function isPermanentApiError(err: unknown): boolean {
  return isMercadoLivreError(err) && ['not_found', 'forbidden', 'bad_request'].includes(err.kind)
}

async function optional<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    if (isPermanentApiError(err)) return null
    throw err
  }
}

export async function processMercadoLivreOrder(
  companyId: number,
  integrationId: number,
  orderId: string,
  deps?: ChannelOrdersDeps,
  preloaded: { shipment?: MlShipment | null } = {},
): Promise<ProcessOrderResult> {
  const d = resolve(deps)
  const integ = await d.repo.getIntegration(companyId, integrationId)
  if (!integ || integ.provider !== 'mercadolivre' || !integ.external_account_id) {
    throw new ChannelOrderError('integration_not_found', 'Integração Mercado Livre não encontrada para a empresa.')
  }
  const api = d.apiFor({ integrationId, companyId })

  const order = await api.fetchOrder(orderId)
  const shipmentId = order.shipping?.id != null ? String(order.shipping.id) : null
  const shipment = preloaded.shipment ?? (shipmentId ? await optional(() => api.fetchShipment(shipmentId)) : null)
  const costs = shipmentId ? await optional(() => api.fetchShipmentCosts(shipmentId)) : null
  const billing = await optional(() => api.fetchBillingOrder(String(order.id)))

  const norm = normalizeMercadoLivreOrder(order, { sellerId: integ.external_account_id, shipment, costs, billing })
  if (!norm.sellerMatches) {
    // Pedido de outro vendedor não entra nesta empresa (defesa de tenant).
    return { channelOrderId: null, action: 'ignored', code: 'seller_mismatch' }
  }

  const listings = await d.repo.findListings(companyId, integrationId)
  const items = mapOrderItems(norm.items, listings)
  // Observável para auditoria: ofertas não identificadas exatamente e avisos de SKU.
  const warnings = items
    .filter((i) => i.listing_resolution !== 'exact' || (i.mapping_note ?? '').startsWith('aviso'))
    .map((i) => ({ external_item_id: i.external_item_id, external_variation_id: i.external_variation_id,
      external_user_product_id: i.external_user_product_id, seller_sku: i.seller_sku, listing_resolution: i.listing_resolution, note: i.mapping_note }))
  const orderPayload = { ...norm.order, metadata: { listing_resolution_warnings: warnings } }
  const up = await d.repo.upsertOrder(companyId, integrationId, 'mercadolivre', orderPayload, items)
  const coId = up.channel_order_id
  const operator = integ.created_by

  switch (norm.decision.action) {
    case 'cancel': {
      if (up.processing_state === 'cancelled') return { channelOrderId: coId, action: 'cancelled', code: 'already_cancelled', saleId: up.sale_id }
      if (!operator) {
        await d.repo.setState(companyId, coId, 'needs_attention', 'no_operator', 'Integração sem usuário operador para cancelar a venda.')
        return { channelOrderId: coId, action: 'needs_attention', code: 'no_operator' }
      }
      const cancelReason = typeof order.cancel_detail?.description === 'string' ? order.cancel_detail.description : order.status
      const r = await d.repo.cancelOrder(companyId, coId, operator, cancelReason)
      return r.result === 'needs_attention'
        ? { channelOrderId: coId, action: 'needs_attention', code: String(r.code ?? ''), saleId: up.sale_id }
        : { channelOrderId: coId, action: 'cancelled', code: String(r.result), saleId: up.sale_id }
    }
    case 'await_payment': {
      if (up.sale_id == null) await d.repo.setState(companyId, coId, 'awaiting_payment')
      return { channelOrderId: coId, action: 'awaiting_payment', saleId: up.sale_id }
    }
    case 'attention': {
      if (up.sale_id == null) await d.repo.setState(companyId, coId, 'needs_attention', norm.decision.code, norm.decision.reason)
      return { channelOrderId: coId, action: 'needs_attention', code: norm.decision.code, saleId: up.sale_id }
    }
    case 'import': {
      if (!operator) {
        await d.repo.setState(companyId, coId, 'needs_attention', 'no_operator', 'Integração sem usuário operador — reconecte a conta Mercado Livre.')
        return { channelOrderId: coId, action: 'needs_attention', code: 'no_operator' }
      }
      if (up.sale_id != null) {
        await d.repo.syncCosts(companyId, coId, operator)
        return { channelOrderId: coId, action: 'costs_synced', saleId: up.sale_id }
      }
      if (norm.unsupportedPayments.length > 0) {
        await d.repo.setState(companyId, coId, 'needs_attention', 'unsupported_payment',
          `Forma de pagamento sem equivalente no Qarvon: ${norm.unsupportedPayments.join(', ')}.`)
        return { channelOrderId: coId, action: 'needs_attention', code: 'unsupported_payment' }
      }
      const r = await d.repo.importOrder(companyId, coId, operator, norm.payments)
      if (r.result === 'imported') return { channelOrderId: coId, action: 'imported', saleId: Number(r.sale_id) }
      if (r.result === 'already_imported') {
        await d.repo.syncCosts(companyId, coId, operator)
        return { channelOrderId: coId, action: 'already_imported', saleId: Number(r.sale_id) }
      }
      if (r.result === 'needs_attention') return { channelOrderId: coId, action: 'needs_attention', code: String(r.code ?? '') }
      return { channelOrderId: coId, action: 'ignored', code: String(r.result) }
    }
  }
}

/** Notificação de envio → relê o envio, acha o pedido e reprocessa (status/custos). */
export async function processMercadoLivreShipment(
  companyId: number,
  integrationId: number,
  shipmentId: string,
  deps?: ChannelOrdersDeps,
): Promise<ProcessOrderResult> {
  const d = resolve(deps)
  const api = d.apiFor({ integrationId, companyId })
  const shipment = await api.fetchShipment(shipmentId)
  if (shipment.order_id == null) return { channelOrderId: null, action: 'ignored', code: 'shipment_without_order' }
  return processMercadoLivreOrder(companyId, integrationId, String(shipment.order_id), deps, { shipment })
}

// ─── Implementações de produção ──────────────────────────────────────────────

function defaultApi(ctx: { integrationId: number; companyId: number; deps?: MercadoLivreRequestDeps }): MlOrderApi {
  return {
    fetchOrder: (id) => fetchOrder(ctx, id),
    fetchShipment: (id) => fetchShipment(ctx, id),
    fetchShipmentCosts: (id) => fetchShipmentCosts(ctx, id),
    fetchBillingOrder: (id) => fetchBillingOrder(ctx, id),
  }
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const admin = createAdminClient() as any
  const { data, error } = await admin.rpc(name, args)
  if (error) throw new Error(`${name}: ${error.message}`)
  return data as T
}

export function createSupabaseChannelOrdersRepo(): ChannelOrdersRepo {
  const admin = createAdminClient() as any
  return {
    async getIntegration(companyId, integrationId) {
      const { data, error } = await admin.from('company_integrations')
        .select('id, company_id, provider, status, external_account_id, created_by')
        .eq('id', integrationId).eq('company_id', companyId).maybeSingle()
      if (error) throw new Error(error.message)
      return data ?? null
    },
    async findListings(companyId, integrationId) {
      const { data, error } = await admin.from('channel_listings')
        .select('id, product_variation_id, seller_sku, external_listing_id, external_variant_id, external_product_id, local_status')
        .eq('company_id', companyId).eq('integration_id', integrationId).neq('local_status', 'closed')
      if (error) throw new Error(error.message)
      return data ?? []
    },
    upsertOrder: (companyId, integrationId, provider, order, items) =>
      rpc<UpsertResult>('rpc_upsert_channel_order', { p_company_id: companyId, p_integration_id: integrationId, p_provider: provider, p_order: order, p_items: items }),
    setState: (companyId, id, state, code, reason) =>
      rpc<boolean>('rpc_set_channel_order_state', { p_company_id: companyId, p_channel_order_id: id, p_state: state, p_code: code ?? null, p_reason: reason ?? null }),
    importOrder: (companyId, id, userId, payments) =>
      rpc('rpc_import_channel_order', { p_company_id: companyId, p_channel_order_id: id, p_system_user_id: userId, p_payments: payments }),
    syncCosts: (companyId, id, userId) =>
      rpc('rpc_sync_channel_order_costs', { p_company_id: companyId, p_channel_order_id: id, p_system_user_id: userId }),
    cancelOrder: (companyId, id, userId, reason) =>
      rpc('rpc_cancel_channel_order', { p_company_id: companyId, p_channel_order_id: id, p_system_user_id: userId, p_reason: reason }),
  }
}

// ─── Consulta para a UI ───────────────────────────────────────────────────────

export interface ChannelOrderListItem {
  id: number
  provider: string
  external_order_id: string
  processing_state: string
  attention_code: string | null
  attention_reason: string | null
  channel_status: string | null
  gross_amount: number | null
  marketplace_fees: number | null
  shipping_cost_seller: number | null
  net_amount: number | null
  sale_id: number | null
  is_test: boolean
  created_at_external: string | null
  last_synced_at: string | null
}

export async function listChannelOrders(companyId: number, state?: string | null, limit = 100): Promise<ChannelOrderListItem[]> {
  const admin = createAdminClient() as any
  let q = admin.from('channel_orders')
    .select('id, provider, external_order_id, processing_state, attention_code, attention_reason, channel_status, gross_amount, marketplace_fees, shipping_cost_seller, net_amount, sale_id, is_test, created_at_external, last_synced_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (state) q = q.eq('processing_state', state)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
}

/** Reprocessa um pedido a pedido do usuário (empresa da sessão; relê na API). */
export async function reprocessChannelOrder(companyId: number, channelOrderId: number, deps?: ChannelOrdersDeps): Promise<ProcessOrderResult> {
  const admin = createAdminClient() as any
  const { data, error } = await admin.from('channel_orders')
    .select('id, provider, integration_id, external_order_id')
    .eq('id', channelOrderId).eq('company_id', companyId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new ChannelOrderError('not_found', 'Pedido não encontrado.')
  if (data.provider !== 'mercadolivre') throw new ChannelOrderError('invalid', 'Canal sem reprocessamento disponível.')
  return processMercadoLivreOrder(companyId, data.integration_id, data.external_order_id, deps)
}
