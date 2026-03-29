/**
 * Service de Vendas — lógica de negócio desacoplada de HTTP.
 *
 * Responsabilidade: validações de integridade e operações multi-tabela
 * para criação, cancelamento e devolução de vendas.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { ServiceOutcome } from './produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface SaleItem {
  product_variation_id: number
  quantity: number
  unit_price: number
  unit_cost: number
  discount_amount: number
}

export interface CreateSaleInput {
  customer_id: number
  payment_method: 'pix' | 'card' | 'cash'
  sale_origin?: string | null
  discount_amount: number
  cashback_used: number
  shipping_charged: number
  notes?: string | null
  items: SaleItem[]
  systemUserId: string
}

export interface SaleResult {
  id: number
  sale_number: string
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): { ok: true; data: T; error?: never; status?: never } {
  return { ok: true, data }
}

function failure(error: string, status = 500): { ok: false; error: string; status: number; data?: never } {
  return { ok: false, error, status }
}

// ─── Verificações ─────────────────────────────────────────────────────────────

/**
 * Verifica disponibilidade de estoque para todos os itens de uma venda.
 * Retorna erro no primeiro item com estoque insuficiente.
 */
export async function validateStockForSale(items: SaleItem[]): Promise<ServiceOutcome> {
  const admin = createAdminClient()

  for (const item of items) {
    const { data: stock } = await admin
      .from('stock')
      .select('quantity')
      .eq('product_variation_id', item.product_variation_id)
      .maybeSingle() as unknown as { data: { quantity: number } | null }

    const available = stock?.quantity ?? 0
    if (available < item.quantity) {
      return failure(
        `Estoque insuficiente para variação #${item.product_variation_id}. ` +
        `Disponível: ${available}, solicitado: ${item.quantity}.`,
        400
      )
    }
  }

  return success(undefined)
}

/**
 * Verifica se uma venda pode ser cancelada ou devolvida.
 */
export async function getSaleForMutation(saleId: number): Promise<ServiceOutcome<{
  sale: Record<string, unknown>
  saleItems: { product_variation_id: number; quantity: number; unit_cost: number }[]
}>> {
  const admin = createAdminClient()

  const { data: sale, error } = await admin
    .from('sales')
    .select('id, status, total, sale_number, sale_items(product_variation_id, quantity, unit_cost)')
    .eq('id', saleId)
    .single() as unknown as {
      data: {
        id: number
        status: string
        total: number
        sale_number: string
        sale_items: { product_variation_id: number; quantity: number; unit_cost: number }[]
      } | null
      error: { message: string } | null
    }

  if (error || !sale) return failure('Venda não encontrada.', 404)

  if (sale.status === 'cancelled' || sale.status === 'returned') {
    return failure(`Venda já ${sale.status === 'cancelled' ? 'cancelada' : 'devolvida'}.`, 400)
  }

  return success({
    sale: sale as unknown as Record<string, unknown>,
    saleItems: sale.sale_items ?? [],
  })
}

/**
 * Restaura estoque de um conjunto de itens (usado em cancelamento/devolução).
 */
export async function restoreStock(
  items: { product_variation_id: number; quantity: number; unit_cost: number }[]
): Promise<ServiceOutcome> {
  const admin = createAdminClient()

  for (const item of items) {
    const { data: current } = await admin
      .from('stock')
      .select('quantity, avg_cost')
      .eq('product_variation_id', item.product_variation_id)
      .single() as unknown as {
        data: { quantity: number; avg_cost: number } | null
      }

    const { error } = await admin.from('stock').upsert(
      {
        product_variation_id: item.product_variation_id,
        quantity: (current?.quantity ?? 0) + item.quantity,
        avg_cost: current?.avg_cost ?? item.unit_cost,
        last_updated: new Date().toISOString(),
      } as any,
      { onConflict: 'product_variation_id' }
    )

    if (error) return failure(error.message)
  }

  return success(undefined)
}

// ─── Validações de regras de negócio ─────────────────────────────────────────

/**
 * Verifica se todos os produtos/variações dos itens estão ativos.
 *
 * Regra: produto inativo ou variação inativa = hard block (erro 400).
 * A inativação de produto é uma decisão consciente do gerente;
 * tentar vendê-lo é sempre um erro operacional.
 */
export async function validateProductsActive(items: SaleItem[]): Promise<ServiceOutcome> {
  const admin = createAdminClient()
  const variationIds = items.map((i) => i.product_variation_id)

  const { data: variations, error } = await admin
    .from('product_variations')
    .select('id, active, products!inner(id, name, active)')
    .in('id', variationIds) as unknown as {
      data: { id: number; active: boolean; products: { id: number; name: string; active: boolean } }[] | null
      error: { message: string } | null
    }

  if (error) return failure(error.message)

  for (const v of variations ?? []) {
    if (!v.active) {
      return failure(`Variação #${v.id} está inativa e não pode ser vendida.`, 400)
    }
    if (!v.products.active) {
      return failure(`Produto "${v.products.name}" está inativo e não pode ser vendido.`, 400)
    }
  }

  return success(undefined)
}

/**
 * Verifica se algum item tem preço de venda abaixo do custo (margem negativa).
 *
 * Retorna sempre `ok: true`, mas inclui warnings quando encontrados.
 * A API route aplica a política por role:
 *   - usuario  → bloqueia (não pode aprovar venda com prejuízo)
 *   - gerente/admin → permite com warning no response (ex.: promoção ou liquidação)
 */
export function checkSalePrices(items: SaleItem[]): { ok: true; warnings: string[] } {
  const warnings: string[] = []
  for (const item of items) {
    if (item.unit_price < item.unit_cost) {
      warnings.push(
        `Var. #${item.product_variation_id}: preço (${item.unit_price}) abaixo do custo (${item.unit_cost}). Margem negativa.`
      )
    }
  }
  return { ok: true, warnings }
}

// ─── Criação de venda ─────────────────────────────────────────────────────────

/**
 * Cria a venda completa de forma ATÔMICA via RPC PL/pgSQL (rpc_create_sale).
 *
 * A função Postgres executa em uma única transação:
 *   INSERT sales → INSERT sale_items (loop) → UPDATE stock (FOR UPDATE) → INSERT finance_entries
 *
 * O FOR UPDATE no stock garante que requisições concorrentes para o mesmo produto
 * nunca causem estoque negativo — a segunda requisição bloqueia até a primeira commitar.
 *
 * Pré-condições (verificadas pela rota antes desta chamada):
 *   - produtos/variações ativos (validateProductsActive)
 *   - estoque disponível (validateStockForSale) — redundante, o RPC verifica novamente
 *   - política de preço/custo (checkSalePrices)
 *
 * Migração aplicada: 002_rpc_transactions.sql
 */
export async function createSale(input: CreateSaleInput): Promise<ServiceOutcome<SaleResult>> {
  const admin = createAdminClient() // admin client: RPC SECURITY DEFINER, equivalente ao service_role

  const { data: sale, error } = await (admin as any)
    .rpc('rpc_create_sale', {
      p_customer_id:      input.customer_id,
      p_seller_id:        input.systemUserId,
      p_payment_method:   input.payment_method,
      p_sale_origin:      input.sale_origin ?? null,
      p_discount_amount:  input.discount_amount,
      p_cashback_used:    input.cashback_used,
      p_shipping_charged: input.shipping_charged,
      p_notes:            input.notes ?? null,
      p_items:            input.items,
      p_system_user_id:   input.systemUserId,
    }) as unknown as {
      data: { id: number; sale_number: string } | null
      error: { code: string; message: string } | null
    }

  if (error) {
    // P0001 = RAISE EXCEPTION do PL/pgSQL = violação de regra de negócio
    const status = error.code === 'P0001' ? 400 : 500
    return failure(error.message, status)
  }

  return success(sale!)
}

// ─── Cancelamento e Devolução ─────────────────────────────────────────────────

/**
 * Cancela uma venda de forma ATÔMICA via RPC (rpc_cancel_sale).
 *
 * A função Postgres executa em uma única transação:
 *   UPDATE sales.status → INSERT stock (restore, loop) → INSERT finance_entries
 *
 * Idempotência: RAISE EXCEPTION se venda já está cancelled/returned.
 * Migração aplicada: 002_rpc_transactions.sql
 */
export async function cancelSale(saleId: number, systemUserId: string): Promise<ServiceOutcome> {
  const admin = createAdminClient()

  const { error } = await (admin as any)
    .rpc('rpc_cancel_sale', {
      p_sale_id:        saleId,
      p_system_user_id: systemUserId,
    }) as unknown as { error: { code: string; message: string } | null }

  if (error) {
    const status = error.code === 'P0001' ? 400 : 500
    return failure(error.message, status)
  }

  return success(undefined)
}

/**
 * Processa devolução de forma ATÔMICA via RPC (rpc_return_sale).
 *
 * Idêntico ao cancelSale em estrutura; apenas muda o status final e a descrição.
 * Migração aplicada: 002_rpc_transactions.sql
 */
export async function returnSale(saleId: number, systemUserId: string): Promise<ServiceOutcome> {
  const admin = createAdminClient()

  const { error } = await (admin as any)
    .rpc('rpc_return_sale', {
      p_sale_id:        saleId,
      p_system_user_id: systemUserId,
    }) as unknown as { error: { code: string; message: string } | null }

  if (error) {
    const status = error.code === 'P0001' ? 400 : 500
    return failure(error.message, status)
  }

  return success(undefined)
}
