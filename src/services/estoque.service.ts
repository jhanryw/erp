/**
 * Service de Estoque — lógica de negócio desacoplada de HTTP.
 *
 * Responsabilidade: ajustes manuais, entradas de lote e carga inicial.
 * Todas as operações passam por RPCs PL/pgSQL que:
 *   - São ACID (transação atômica, sem race condition)
 *   - Registram cada movimentação em stock_movements
 *   - Bloqueiam escrita direta na tabela stock via trigger
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { ServiceOutcome } from './produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface StockAdjustInput {
  product_variation_id: number
  /** Positivo = entrada, negativo = saída */
  delta: number
  reason: string
  notes?: string
}

export interface StockAdjustResult {
  new_quantity: number
  previous_quantity: number
  delta: number
}

export interface StockEntryInput {
  product_variation_id: number
  supplier_id?: number | null
  entry_type: string
  quantity_original: number
  unit_cost: number
  freight_cost?: number
  tax_cost?: number
  entry_date: string
  notes?: string | null
}

export interface StockEntryResult {
  lot_id: string
  new_quantity: number
  new_avg_cost: number
  total_lot_cost: number
  cost_per_unit: number
}

export interface StockInitializeInput {
  product_variation_id: number
  /** Quantidade inicial — 0 é válido (cria o registro sem movimento) */
  quantity: number
  /** Custo médio inicial (cost_override ou base_cost do produto) */
  avg_cost: number
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): { ok: true; data: T; error?: never; status?: never } {
  return { ok: true, data }
}

function failure(error: string, status = 500): { ok: false; error: string; status: number; data?: never } {
  return { ok: false, error, status }
}

// ─── Carga inicial de estoque ─────────────────────────────────────────────────

/**
 * Cria o registro de estoque inicial para uma nova variação de produto.
 *
 * Diferente de rpc_stock_entry (que registra compra formal com custo médio):
 * - Não cria stock_lot (não é uma compra rastreável por NF)
 * - Não lança finance_entry (não poluir o fluxo financeiro com estoque pré-operação)
 * - Cria movimento tipo 'initial' em stock_movements se quantity > 0
 * - Cria o registro de estoque zerado se quantity = 0
 *
 * Transação atômica via rpc_stock_initialize (SECURITY DEFINER).
 */
export async function initializeStock(
  input: StockInitializeInput,
  systemUserId: string
): Promise<ServiceOutcome<void>> {
  const admin = createAdminClient()

  const { error } = await (admin as any).rpc('rpc_stock_initialize', {
    p_product_variation_id: input.product_variation_id,
    p_quantity:             input.quantity,
    p_avg_cost:             input.avg_cost,
    p_system_user_id:       systemUserId,
  }) as unknown as {
    error: { code: string; message: string } | null
  }

  if (error) {
    return failure(error.message, error.code === 'P0001' ? 400 : 500)
  }

  return success(undefined as void)
}

// ─── Ajuste manual de estoque ─────────────────────────────────────────────────

/**
 * Aplica um ajuste manual de estoque (positivo ou negativo).
 *
 * Regras de negócio:
 * - Delta não pode ser zero (validado na rota antes de chegar aqui).
 * - Resultado não pode ser negativo (checked aqui).
 * - Saídas geram lançamento financeiro de despesa (custo médio × unidades retiradas).
 *
 * Transação atômica via Supabase RPC (rpc_stock_adjust).
 */
export async function adjustStock(
  input: StockAdjustInput,
  systemUserId: string
): Promise<ServiceOutcome<StockAdjustResult>> {
  const admin = createAdminClient() // admin client: RPC SECURITY DEFINER

  const { data, error } = await (admin as any).rpc('rpc_stock_adjust', {
    p_product_variation_id: input.product_variation_id,
    p_delta: input.delta,
    p_reason: input.reason,
    p_notes: input.notes ?? null,
    p_system_user_id: systemUserId,
  }) as unknown as {
    data: StockAdjustResult | null
    error: { code: string; message: string } | null
  }

  if (error) {
    const status = error.code === 'P0001' ? 400 : 500
    return failure(error.message, status)
  }

  return success(data!)
}

// ─── Entrada de lote ──────────────────────────────────────────────────────────

/**
 * Registra uma entrada de estoque via lote (compra NF, bonificação, produção própria).
 *
 * Custo médio ponderado:
 *   new_avg = (prev_qty × prev_avg + new_qty × cost_per_unit) / (prev_qty + new_qty)
 *
 * Transação atômica via Supabase RPC (rpc_stock_entry).
 */
export async function createStockEntry(
  input: StockEntryInput,
  systemUserId: string
): Promise<ServiceOutcome<StockEntryResult>> {
  const admin = createAdminClient() // admin client: RPC SECURITY DEFINER

  const { data, error } = await (admin as any).rpc('rpc_stock_entry', {
    p_product_variation_id: input.product_variation_id,
    p_supplier_id: input.supplier_id ?? null,
    p_entry_type: input.entry_type,
    p_quantity_original: input.quantity_original,
    p_unit_cost: input.unit_cost,
    p_freight_cost: input.freight_cost ?? 0,
    p_tax_cost: input.tax_cost ?? 0,
    p_entry_date: input.entry_date,
    p_notes: input.notes ?? null,
    p_system_user_id: systemUserId,
  }) as unknown as {
    data: StockEntryResult | null
    error: { code: string; message: string } | null
  }

  if (error) {
    const status = error.code === 'P0001' ? 400 : 500
    return failure(error.message, status)
  }

  return success(data!)
}
