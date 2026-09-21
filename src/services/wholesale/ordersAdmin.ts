/**
 * Leitura/gestão administrativa dos pedidos de atacado. Sempre filtrada por
 * `company_id` da SESSÃO — não existe leitura pública de pedido.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadOrderById, type PersistedOrder } from './orders'

export const ORDERS_PAGE_SIZE = 50
import type { WholesaleOrderStatus } from './orderStatus'
export { ORDER_STATUSES, ORDER_STATUS_LABEL, type WholesaleOrderStatus } from './orderStatus'

export interface OrderListRow {
  id: string
  code: string
  status: WholesaleOrderStatus
  customerName: string
  customerPhone: string
  totalItems: number
  subtotal: number
  createdAt: string
}

/** Remove caracteres que quebrariam a sintaxe do `.or()` do PostgREST. */
const sanitize = (s: string) => s.replace(/[,()%*\\]/g, ' ').trim()

export async function listWholesaleOrders(
  admin: SupabaseClient,
  companyId: number,
  filters: { status?: WholesaleOrderStatus; search?: string; page?: number },
): Promise<{ orders: OrderListRow[]; total: number; page: number; totalPages: number }> {
  const page = Math.max(1, filters.page ?? 1)
  const offset = (page - 1) * ORDERS_PAGE_SIZE

  let query = (admin as any)
    .from('wholesale_orders')
    .select('id, code, status, customer_name, customer_phone, total_items, subtotal, created_at', { count: 'exact' })
    .eq('company_id', companyId)
  if (filters.status) query = query.eq('status', filters.status)
  const search = filters.search ? sanitize(filters.search) : ''
  if (search) query = query.or(`code.ilike.%${search}%,customer_name.ilike.%${search}%,customer_phone.ilike.%${search}%`)

  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + ORDERS_PAGE_SIZE - 1) as
    { data: any[] | null; count: number | null; error: { message: string } | null }
  if (error) throw new Error(`Falha ao listar pedidos de atacado: ${error.message}`)

  const total = count ?? data?.length ?? 0
  return {
    orders: (data ?? []).map((r) => ({
      id: r.id, code: r.code, status: r.status, customerName: r.customer_name, customerPhone: r.customer_phone,
      totalItems: r.total_items, subtotal: Number(r.subtotal), createdAt: r.created_at,
    })),
    total, page, totalPages: Math.max(1, Math.ceil(total / ORDERS_PAGE_SIZE)),
  }
}

export async function getWholesaleOrder(admin: SupabaseClient, companyId: number, orderId: string): Promise<PersistedOrder | null> {
  return loadOrderById(admin, companyId, orderId)
}

/** Troca simples de status (sem workflow). Não toca em estoque nem cria venda. */
export async function updateWholesaleOrderStatus(
  admin: SupabaseClient,
  companyId: number,
  orderId: string,
  status: WholesaleOrderStatus,
): Promise<boolean> {
  const { data, error } = await (admin as any)
    .from('wholesale_orders')
    .update({ status })
    .eq('company_id', companyId)
    .eq('id', orderId)
    .select('id') as { data: { id: string }[] | null; error: { message: string } | null }
  if (error) throw new Error(`Falha ao atualizar o pedido: ${error.message}`)
  return (data?.length ?? 0) > 0
}
