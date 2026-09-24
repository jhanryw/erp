/**
 * Pedidos do Mercado Livre → modelo genérico de channel_orders.
 *
 * A notificação NUNCA é a fonte de verdade: o worker sempre relê o recurso
 * na API. Origem de cada valor (docs oficiais "Orders", "Envios",
 * "Provisões", consultadas em 24/09/2026):
 *
 *   valor bruto          GET /orders/{id} → Σ order_items[].unit_price × quantity
 *                        (unit_price já com desconto; gross_price/discounts
 *                        guardados só como informação)
 *   tarifa de venda      GET /orders/{id} → payments[].marketplace_fee (total
 *                        do pagamento) quando presente; senão
 *                        Σ order_items[].sale_fee × quantity (sale_fee é por unidade)
 *   frete do vendedor    GET /shipments/{id}/costs (x-format-new) →
 *                        senders[user_id = seller].cost
 *   frete do comprador   GET /shipments/{id}/costs → receiver.cost (informativo)
 *   impostos             GET /orders/{id} → taxes.amount
 *   liberação prevista   GET /billing/integration/group/ML/order/details?order_ids=
 *                        → payment_info[].money_release_date (quando faturado)
 *   pagamento            GET /orders/{id} → payments[] (id, status, payment_type,
 *                        payment_method_id, installments, transaction_amount,
 *                        total_paid_amount, date_approved, currency_id)
 *
 * Nada é estimado: valor ausente fica null e a fonte fica registrada.
 */

import { mercadoLivreRequest, type MercadoLivreRequestDeps } from './client'
import { isMercadoLivreError } from './errors'

interface Ctx {
  integrationId: number
  companyId: number
  deps?: MercadoLivreRequestDeps
}

// ─── Formato (parcial) da API ────────────────────────────────────────────────

export interface MlOrderItem {
  item: { id: string; title?: string; variation_id?: number | string | null; seller_sku?: string | null; seller_custom_field?: string | null; user_product_id?: string | null }
  quantity: number
  unit_price: number
  sale_fee?: number | null
  listing_type_id?: string | null
  gross_price?: number | null
}

export interface MlPayment {
  id: number | string
  status: string
  status_detail?: string | null
  payment_type?: string | null
  payment_method_id?: string | null
  installments?: number | null
  installment_amount?: number | null
  transaction_amount?: number | null
  total_paid_amount?: number | null
  shipping_cost?: number | null
  marketplace_fee?: number | null
  date_approved?: string | null
  currency_id?: string | null
}

export interface MlOrder {
  id: number | string
  status: string
  status_detail?: unknown
  date_created?: string | null
  date_closed?: string | null
  last_updated?: string | null
  pack_id?: number | string | null
  total_amount?: number | null
  paid_amount?: number | null
  currency_id?: string | null
  order_items: MlOrderItem[]
  payments?: MlPayment[]
  shipping?: { id?: number | string | null } | null
  buyer?: { id?: number | string | null; nickname?: string | null } | null
  seller?: { id?: number | string | null } | null
  tags?: string[]
  taxes?: { amount?: number | null } | null
  cancel_detail?: { group?: string; code?: string; description?: string; requested_by?: string } | null
}

export interface MlShipment {
  id: number | string
  order_id?: number | string | null
  status?: string | null
  substatus?: string | null
  mode?: string | null
  logistic_type?: string | null
  tracking_number?: string | null
}

export interface MlShipmentCosts {
  gross_amount?: number | null
  receiver?: { user_id?: number | string; cost?: number | null } | null
  senders?: Array<{ user_id?: number | string; cost?: number | null }> | null
}

export interface MlBillingOrder {
  order_id?: number | string
  payment_info?: Array<{ payment_id?: number | string; money_release_date?: string | null; money_release_status?: string | null }>
  sale_fee?: { gross?: number; net?: number; rebate?: number; discount?: number } | null
}

// ─── Chamadas ────────────────────────────────────────────────────────────────

const call = <T>(ctx: Ctx, path: string, query?: Record<string, string>, headers?: Record<string, string>) =>
  mercadoLivreRequest<T>({ integrationId: ctx.integrationId, companyId: ctx.companyId, method: 'GET', path, query, headers, deps: ctx.deps })

export async function fetchOrder(ctx: Ctx, orderId: string): Promise<MlOrder> {
  return (await call<MlOrder>(ctx, `/orders/${encodeURIComponent(orderId)}`)).data
}

export async function fetchShipment(ctx: Ctx, shipmentId: string): Promise<MlShipment> {
  return (await call<MlShipment>(ctx, `/shipments/${encodeURIComponent(shipmentId)}`, undefined, { 'x-format-new': 'true' })).data
}

export async function fetchShipmentCosts(ctx: Ctx, shipmentId: string): Promise<MlShipmentCosts> {
  return (await call<MlShipmentCosts>(ctx, `/shipments/${encodeURIComponent(shipmentId)}/costs`, undefined, { 'x-format-new': 'true' })).data
}

/** Faturamento do pedido (liberação prevista). Só existe depois que o ML fatura — 404/vazio é normal. */
export async function fetchBillingOrder(ctx: Ctx, orderId: string): Promise<MlBillingOrder | null> {
  try {
    const res = await call<{ results?: MlBillingOrder[] }>(ctx, '/billing/integration/group/ML/order/details', { order_ids: orderId })
    return res.data?.results?.find((r) => String(r.order_id) === String(orderId)) ?? null
  } catch (err) {
    if (isMercadoLivreError(err) && (err.kind === 'not_found' || err.kind === 'bad_request' || err.kind === 'forbidden')) return null
    throw err
  }
}

/** Recurso da notificação → id do pedido (orders_v2) ou do envio (shipments). */
export function parseNotificationResource(topic: string, resource: string): { kind: 'order' | 'shipment'; id: string } | null {
  const order = resource.match(/^\/orders\/(\d+)$/)
  if ((topic === 'orders_v2' || topic === 'orders') && order) return { kind: 'order', id: order[1] }
  const ship = resource.match(/^\/shipments\/(\d+)$/)
  if (topic === 'shipments' && ship) return { kind: 'shipment', id: ship[1] }
  return null
}

// ─── Normalização pura ──────────────────────────────────────────────────────

export type OrderAction = 'import' | 'await_payment' | 'cancel' | 'attention'

/**
 * Estados do pedido ML (doc "Orders" → Status da order) → ação no Qarvon:
 *   paid                                   → import (pedido pago = processável)
 *   confirmed, payment_required,
 *   payment_in_process, partially_paid     → await_payment (só channel_order)
 *   cancelled, invalid, pending_cancel     → cancel (pending_cancel = cancelado
 *                                            com dificuldade de estorno)
 *   partially_refunded                     → attention (sem devolução parcial automática)
 *   tag fraud_risk_detected                → attention (não importar; se já
 *                                            importado, só sinaliza)
 */
export function decideOrderAction(order: Pick<MlOrder, 'status' | 'tags'>): { action: OrderAction; code?: string; reason?: string } {
  const tags = order.tags ?? []
  if (['cancelled', 'invalid', 'pending_cancel'].includes(order.status)) return { action: 'cancel' }
  if (tags.includes('fraud_risk_detected')) {
    return { action: 'attention', code: 'fraud_risk', reason: 'Mercado Livre marcou o pedido com risco de fraude (fraud_risk_detected) — não enviar a mercadoria.' }
  }
  if (order.status === 'paid') return { action: 'import' }
  if (order.status === 'partially_refunded') {
    return { action: 'attention', code: 'partial_refund', reason: 'Pedido com reembolso parcial no Mercado Livre — tratar devolução manualmente.' }
  }
  if (['confirmed', 'payment_required', 'payment_in_process', 'partially_paid'].includes(order.status)) return { action: 'await_payment' }
  return { action: 'attention', code: 'unknown_status', reason: `Status do pedido não reconhecido: ${order.status}` }
}

/** Método de pagamento do Qarvon a partir do ML — sem distorcer (original vai em metadata). */
export function mapPaymentMethod(p: Pick<MlPayment, 'payment_type' | 'payment_method_id'>): string | null {
  const type = (p.payment_type ?? '').toLowerCase()
  const method = (p.payment_method_id ?? '').toLowerCase()
  if (type === 'credit_card') return 'credit_card'
  if (type === 'debit_card') return 'debit_card'
  if (method === 'pix' || (type === 'bank_transfer' && method.includes('pix'))) return 'pix'
  if (['account_money', 'digital_currency', 'digital_wallet', 'consumer_credits'].includes(type)) return 'digital_wallet'
  if (type === 'ticket') return 'boleto'
  return null
}

const round2 = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

export interface NormalizedPayment {
  method: string
  net_amount: number
  installments: number
  card_brand: string | null
  external_payment_id: string
  metadata: Record<string, unknown>
}

export interface NormalizedOrderItem {
  external_item_id: string
  external_variation_id: string | null
  external_user_product_id: string | null
  seller_sku: string | null
  title: string | null
  quantity: number
  unit_price: number
  sale_fee: number | null
  listing_type_id: string | null
}

export interface NormalizedOrder {
  order: Record<string, unknown>
  items: NormalizedOrderItem[]
  payments: NormalizedPayment[]
  unsupportedPayments: string[]
  decision: ReturnType<typeof decideOrderAction>
  sellerMatches: boolean
}

export function normalizeMercadoLivreOrder(
  order: MlOrder,
  input: { sellerId: string; shipment?: MlShipment | null; costs?: MlShipmentCosts | null; billing?: MlBillingOrder | null },
): NormalizedOrder {
  const items: NormalizedOrderItem[] = (order.order_items ?? []).map((oi) => {
    const qty = Math.max(0, Math.floor(Number(oi.quantity ?? 0)))
    const unitFee = num(oi.sale_fee)
    return {
      external_item_id: String(oi.item?.id ?? ''),
      external_variation_id: oi.item?.variation_id != null ? String(oi.item.variation_id) : null,
      external_user_product_id: oi.item?.user_product_id ?? null,
      seller_sku: (oi.item?.seller_sku ?? oi.item?.seller_custom_field ?? null) || null,
      title: oi.item?.title ?? null,
      quantity: qty,
      unit_price: round2(Number(oi.unit_price ?? 0)),
      sale_fee: unitFee != null ? round2(unitFee * qty) : null,
      listing_type_id: oi.listing_type_id ?? null,
    }
  })

  const gross = round2(items.reduce((s, i) => s + i.unit_price * i.quantity, 0))
  const approved = (order.payments ?? []).filter((p) => p.status === 'approved')

  // Tarifa: total por pagamento (marketplace_fee) quando o ML informar; senão Σ sale_fee × qty.
  const paymentFees = approved.map((p) => num(p.marketplace_fee)).filter((v): v is number => v != null)
  const itemFees = items.map((i) => i.sale_fee).filter((v): v is number => v != null)
  let fees: number | null = null
  let feeSource = 'indisponível'
  if (paymentFees.length > 0) {
    fees = round2(paymentFees.reduce((a, b) => a + b, 0))
    feeSource = 'GET /orders/{id} payments[].marketplace_fee'
  } else if (itemFees.length === items.length && items.length > 0) {
    fees = round2(itemFees.reduce((a, b) => a + b, 0))
    feeSource = 'GET /orders/{id} order_items[].sale_fee × quantity'
  }

  const sellerCostRaw = input.costs?.senders?.find((s) => String(s.user_id) === String(input.sellerId))?.cost
  const shippingSeller = input.costs ? round2(num(sellerCostRaw) ?? 0) : (order.shipping?.id ? null : 0)
  const shippingBuyer = input.costs ? num(input.costs.receiver?.cost) : round2(approved.reduce((s, p) => s + (num(p.shipping_cost) ?? 0), 0))
  const taxes = num(order.taxes?.amount)
  const releaseDates = (input.billing?.payment_info ?? []).map((p) => p.money_release_date).filter((d): d is string => Boolean(d)).sort()
  const moneyRelease = releaseDates.length ? releaseDates[releaseDates.length - 1] : null
  const net = fees != null && shippingSeller != null ? round2(gross - fees - shippingSeller) : null
  const paid = num(order.paid_amount) ?? round2(approved.reduce((s, p) => s + (num(p.total_paid_amount) ?? num(p.transaction_amount) ?? 0), 0))

  // Pagamentos da venda: valor COMERCIAL (bruto) rateado pelos pagamentos aprovados.
  const unsupported: string[] = []
  const totalTx = approved.reduce((s, p) => s + (num(p.transaction_amount) ?? 0), 0)
  let allocated = 0
  const payments: NormalizedPayment[] = []
  approved.forEach((p, idx) => {
    const method = mapPaymentMethod(p)
    if (!method) {
      unsupported.push(`${p.payment_type ?? '?'}/${p.payment_method_id ?? '?'}`)
      return
    }
    const last = idx === approved.length - 1
    const share = totalTx > 0 ? (num(p.transaction_amount) ?? 0) / totalTx : 1 / approved.length
    const amount = last ? round2(gross - allocated) : round2(gross * share)
    allocated = round2(allocated + amount)
    payments.push({
      method,
      net_amount: amount,
      installments: Math.max(1, Number(p.installments ?? 1)),
      card_brand: method === 'credit_card' || method === 'debit_card' ? (p.payment_method_id ?? null) : null,
      external_payment_id: String(p.id),
      metadata: {
        provider: 'mercadolivre',
        provider_payment_id: String(p.id),
        provider_payment_type: p.payment_type ?? null,
        provider_payment_method: p.payment_method_id ?? null,
        status: p.status,
        status_detail: p.status_detail ?? null,
        installments: p.installments ?? null,
        installment_amount: p.installment_amount ?? null,
        transaction_amount: p.transaction_amount ?? null,
        total_paid_amount: p.total_paid_amount ?? null,
        shipping_cost: p.shipping_cost ?? null,
        marketplace_fee: p.marketplace_fee ?? null,
        date_approved: p.date_approved ?? null,
        currency_id: p.currency_id ?? order.currency_id ?? null,
      },
    })
  })

  const tags = order.tags ?? []
  const normalized: Record<string, unknown> = {
    external_order_id: String(order.id),
    external_pack_id: order.pack_id != null ? String(order.pack_id) : null,
    external_shipment_id: order.shipping?.id != null ? String(order.shipping.id) : null,
    channel_status: order.status,
    payment_status: approved.length ? 'approved' : (order.payments ?? [])[0]?.status ?? null,
    shipping_status: input.shipment?.status ?? null,
    shipping_substatus: input.shipment?.substatus ?? null,
    shipping_mode: input.shipment?.mode ?? null,
    shipping_logistic_type: input.shipment?.logistic_type ?? null,
    tracking_number: input.shipment?.tracking_number ?? null,
    buyer_external_id: order.buyer?.id != null ? String(order.buyer.id) : null,
    buyer_nickname: order.buyer?.nickname ?? null,
    currency: order.currency_id ?? null,
    gross_amount: gross,
    paid_amount: paid,
    marketplace_fees: fees,
    shipping_cost_seller: shippingSeller,
    shipping_cost_buyer: shippingBuyer,
    other_costs: 0,
    taxes_amount: taxes,
    net_amount: net,
    money_release_date: moneyRelease,
    financial_sources: {
      gross_amount: 'GET /orders/{id} Σ order_items[].unit_price × quantity',
      marketplace_fees: feeSource,
      shipping_cost_seller: input.costs ? 'GET /shipments/{id}/costs senders[seller].cost' : (order.shipping?.id ? 'pendente (custos do envio indisponíveis)' : 'sem envio'),
      shipping_cost_buyer: input.costs ? 'GET /shipments/{id}/costs receiver.cost' : 'GET /orders/{id} payments[].shipping_cost',
      money_release_date: moneyRelease ? 'GET /billing/integration/group/ML/order/details payment_info[].money_release_date' : 'ainda não faturado',
      billing_sale_fee: input.billing?.sale_fee ?? null,
    },
    is_test: tags.includes('test_order'),
    tags,
    raw_snapshot: {
      status: order.status,
      date_created: order.date_created ?? null,
      date_closed: order.date_closed ?? null,
      total_amount: order.total_amount ?? null,
      paid_amount: order.paid_amount ?? null,
      items: items.map((i) => ({ id: i.external_item_id, variation_id: i.external_variation_id, qty: i.quantity, unit_price: i.unit_price, sale_fee: i.sale_fee })),
      payments: approved.map((p) => ({ id: String(p.id), type: p.payment_type ?? null, method: p.payment_method_id ?? null, status: p.status })),
      cancel_detail: order.cancel_detail ?? null,
    },
    created_at_external: order.date_created ?? null,
    updated_at_external: order.last_updated ?? null,
  }

  return {
    order: normalized,
    items,
    payments,
    unsupportedPayments: unsupported,
    decision: decideOrderAction(order),
    sellerMatches: order.seller?.id == null || String(order.seller.id) === String(input.sellerId),
  }
}
