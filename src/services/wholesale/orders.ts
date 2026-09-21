/**
 * Pedido (intenção de compra) do catálogo de atacado.
 *
 * NÃO cria venda, NÃO baixa nem reserva estoque. O navegador só envia
 * `variation_id` + `quantity` + nome/telefone do comprador; o servidor
 * reconstrói produto, SKU, atributos, preço, subtotais, total e pedido mínimo
 * a partir do banco (mesma regra de vendabilidade do catálogo), grava o
 * snapshot em UMA transação (`rpc_create_wholesale_order`) e devolve o pedido
 * persistido — a mensagem de WhatsApp é gerada a partir dele.
 */

import { createHmac } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/errors/log'
import { normalizePhoneBR } from '@/lib/utils/phone'
import { resolveWholesaleCart, type CartValidationResult } from './cartValidation'
import type { WholesaleSiteSettings } from './settings'

export const ORDER_MAX_LINES = 200
export const ORDER_MAX_QUANTITY_PER_LINE = 10000
/** Anti-spam (compartilhado entre instâncias — contado no banco, ver a RPC). */
export const ORDER_MAX_PER_IP_HOUR = 30
export const ORDER_MAX_PER_PHONE_HOUR = 10
/** Teto global por empresa/hora — proteção que não depende de confiar em IP nem telefone. */
export const ORDER_MAX_PER_COMPANY_HOUR = 200

export interface PersistedOrderItem {
  position: number
  variationId: number | null
  productId: number | null
  productName: string
  sku: string
  attributes: { type: string; value: string }[]
  quantity: number
  unitPrice: number
  subtotal: number
}

export interface PersistedOrder {
  id: string
  code: string
  status: 'pending' | 'finalized' | 'cancelled'
  customerName: string
  customerPhone: string
  totalItems: number
  subtotal: number
  minimumOrderAmount: number
  saleId: number | null
  createdAt: string
  updatedAt: string
  items: PersistedOrderItem[]
}

export type CreateOrderOutcome =
  | { ok: true; replay: boolean; order: PersistedOrder }
  | {
      ok: false
      status: number
      error: 'invalid_customer' | 'whatsapp_not_configured' | 'items_unavailable' | 'below_minimum' | 'rate_limited' | 'create_failed'
      message: string
      validation?: CartValidationResult
      minimumOrder?: number
      currentTotal?: number
      missingAmount?: number
    }

export interface CreateOrderInput {
  companyId: number
  settings: Pick<WholesaleSiteSettings, 'whatsappPhone'>
  idempotencyKey: string
  customer: { name: string; phone: string }
  items: { variationId: number; quantity: number }[]
  /** IP de origem — só é gravado o HMAC. */
  clientIp: string | null
}

/** HMAC do IP (chave = service role) — nunca o IP cru no banco. */
export function hashRequestIp(ip: string | null): string | null {
  if (!ip) return null
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'wholesale-orders'
  return createHmac('sha256', secret).update(ip).digest('hex')
}

export function normalizeCustomerName(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').trim()
  return name.length >= 2 && name.length <= 80 ? name : null
}

// ─── Leitura do pedido persistido ───────────────────────────────────────────

interface OrderRow {
  id: string; code: string; status: PersistedOrder['status']; customer_name: string; customer_phone: string
  total_items: number; subtotal: number | string; minimum_order_amount: number | string; sale_id: number | null
  created_at: string; updated_at: string
}
interface ItemRow {
  position: number; variation_id: number | null; product_id: number | null; product_name: string; sku: string
  attributes: { type: string; value: string }[] | null; quantity: number; unit_price: number | string; subtotal: number | string
}

export function mapOrder(row: OrderRow, items: ItemRow[]): PersistedOrder {
  return {
    id: row.id, code: row.code, status: row.status,
    customerName: row.customer_name, customerPhone: row.customer_phone,
    totalItems: row.total_items, subtotal: Number(row.subtotal), minimumOrderAmount: Number(row.minimum_order_amount),
    saleId: row.sale_id, createdAt: row.created_at, updatedAt: row.updated_at,
    items: items.map((i) => ({
      position: i.position, variationId: i.variation_id, productId: i.product_id,
      productName: i.product_name, sku: i.sku, attributes: i.attributes ?? [],
      quantity: i.quantity, unitPrice: Number(i.unit_price), subtotal: Number(i.subtotal),
    })),
  }
}

const ORDER_COLUMNS = 'id, code, status, customer_name, customer_phone, total_items, subtotal, minimum_order_amount, sale_id, created_at, updated_at'
const ITEM_COLUMNS = 'position, variation_id, product_id, product_name, sku, attributes, quantity, unit_price, subtotal'

/** Pedido + itens da empresa (sempre filtrado por `company_id`). */
export async function loadOrderById(admin: SupabaseClient, companyId: number, orderId: string): Promise<PersistedOrder | null> {
  const { data: row, error } = await (admin as any)
    .from('wholesale_orders').select(ORDER_COLUMNS)
    .eq('company_id', companyId).eq('id', orderId).maybeSingle() as { data: OrderRow | null; error: { message: string } | null }
  if (error) throw new Error(`Falha ao ler o pedido: ${error.message}`)
  if (!row) return null

  const { data: items, error: itemsError } = await (admin as any)
    .from('wholesale_order_items').select(ITEM_COLUMNS)
    .eq('company_id', companyId).eq('order_id', orderId)
    .order('position', { ascending: true }) as { data: ItemRow[] | null; error: { message: string } | null }
  if (itemsError) throw new Error(`Falha ao ler os itens do pedido: ${itemsError.message}`)

  return mapOrder(row, items ?? [])
}

async function loadOrderByIdempotencyKey(admin: SupabaseClient, companyId: number, key: string): Promise<PersistedOrder | null> {
  const { data } = await (admin as any)
    .from('wholesale_orders').select('id')
    .eq('company_id', companyId).eq('idempotency_key', key).maybeSingle() as { data: { id: string } | null }
  return data ? loadOrderById(admin, companyId, data.id) : null
}

// ─── Criação ────────────────────────────────────────────────────────────────

export async function createWholesaleOrder(input: CreateOrderInput): Promise<CreateOrderOutcome> {
  const fail = (status: number, error: Extract<CreateOrderOutcome, { ok: false }>['error'], message: string, extra: object = {}): CreateOrderOutcome =>
    ({ ok: false, status, error, message, ...extra })

  const name = normalizeCustomerName(input.customer.name)
  if (!name) return fail(422, 'invalid_customer', 'Informe seu nome.')
  const phone = normalizePhoneBR(input.customer.phone)
  if (!phone.ok) return fail(422, 'invalid_customer', 'Informe um WhatsApp válido com DDD.')

  // Sem WhatsApp da empresa configurado não faz sentido registrar o pedido.
  if (!normalizePhoneBR(input.settings.whatsappPhone).ok) {
    return fail(503, 'whatsapp_not_configured', 'Pedidos temporariamente indisponíveis.')
  }

  const admin = createAdminClient()

  // Retry/duplo clique: mesma chave → devolve o pedido já criado, sem revalidar nem criar outro.
  const existing = await loadOrderByIdempotencyKey(admin as any, input.companyId, input.idempotencyKey)
  if (existing) return { ok: true, replay: true, order: existing }

  // Mesma variação repetida vira uma linha só (quantidades somadas).
  const merged = new Map<number, number>()
  for (const item of input.items) merged.set(item.variationId, (merged.get(item.variationId) ?? 0) + item.quantity)
  const cart = Array.from(merged, ([variationId, quantity]) => ({ variationId, quantity }))
  if (cart.length > ORDER_MAX_LINES || cart.some((i) => i.quantity > ORDER_MAX_QUANTITY_PER_LINE)) {
    return fail(422, 'items_unavailable', 'Carrinho fora dos limites permitidos.')
  }

  // Tudo reconstruído do banco pela MESMA regra do catálogo.
  const { validation, lines } = await resolveWholesaleCart(input.companyId, cart, { snapshot: true })

  if (!validation.valid) {
    // Nunca cria um pedido diferente do solicitado: devolve o que mudou e o cliente confirma de novo.
    return fail(409, 'items_unavailable', 'Alguns itens mudaram de disponibilidade. Revise o carrinho.', { validation })
  }
  if (!validation.summary.meetsMinimum) {
    return fail(422, 'below_minimum', 'Pedido abaixo do valor mínimo.', {
      minimumOrder: validation.summary.minimumOrderAmount,
      currentTotal: validation.summary.subtotal,
      missingAmount: validation.summary.missingForMinimum,
    })
  }

  const { data, error } = await (admin as any).rpc('rpc_create_wholesale_order', {
    p_company_id: input.companyId,
    p_idempotency_key: input.idempotencyKey,
    p_customer_name: name,
    p_customer_phone: phone.e164,
    p_minimum_order_amount: validation.summary.minimumOrderAmount,
    p_request_ip_hash: hashRequestIp(input.clientIp),
    p_items: lines.map((l) => ({
      variation_id: l.variationId, product_id: l.productId, product_name: l.productName, sku: l.sku,
      attributes: l.attributes, quantity: l.quantity, unit_price: l.unitPrice,
    })),
    p_max_per_ip_hour: ORDER_MAX_PER_IP_HOUR,
    p_max_per_phone_hour: ORDER_MAX_PER_PHONE_HOUR,
    p_max_per_company_hour: ORDER_MAX_PER_COMPANY_HOUR,
  }) as { data: { ok: boolean; error?: string; order_id?: string; replay?: boolean } | null; error: { message: string } | null }

  // Logs sem PII: só empresa, chave de idempotência e nº de linhas (nunca nome/telefone/payload).
  const logContext = { company_id: input.companyId, idempotency_key: input.idempotencyKey, lines: lines.length }
  if (error || !data) {
    logError({ route: 'wholesale.createOrder (rpc)', err: new Error(error?.message ?? 'RPC sem resposta'), context: { ...logContext, code: (error as any)?.code } })
    return fail(500, 'create_failed', 'Não foi possível registrar o pedido. Tente novamente.')
  }
  if (!data.ok) {
    if (data.error === 'rate_limited') {
      console.warn(JSON.stringify({ _type: 'warn', event: 'wholesale_order_rate_limited', ts: new Date().toISOString(), ...logContext }))
      return fail(429, 'rate_limited', 'Muitos pedidos em pouco tempo. Tente novamente mais tarde.')
    }
    if (data.error === 'below_minimum') {
      return fail(422, 'below_minimum', 'Pedido abaixo do valor mínimo.', {
        minimumOrder: validation.summary.minimumOrderAmount, currentTotal: validation.summary.subtotal, missingAmount: validation.summary.missingForMinimum,
      })
    }
    logError({ route: 'wholesale.createOrder (rpc rejected)', err: new Error(`RPC retornou ok=false: ${data.error}`), context: logContext })
    return fail(500, 'create_failed', 'Não foi possível registrar o pedido. Tente novamente.')
  }

  const order = await loadOrderById(admin as any, input.companyId, data.order_id!)
  if (!order) return fail(500, 'create_failed', 'Pedido registrado, mas não foi possível carregá-lo.')
  return { ok: true, replay: Boolean(data.replay), order }
}
