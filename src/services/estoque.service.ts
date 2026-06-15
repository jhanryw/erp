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
  notes?: string | null
  /** null = Estoque Loja da empresa */
  stock_location_id?: number | null
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
  /** null = Estoque Loja da empresa */
  stock_location_id?: number | null
}

export interface StockTransferInput {
  product_variation_id: number
  from_location_id: number
  to_location_id: number
  quantity: number
  notes?: string | null
}

export interface StockTransferResult {
  transfer_id: string
  from_location_id: number
  to_location_id: number
  quantity: number
  from_qty_after: number
  to_qty_after: number
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
    p_delta:                input.delta,
    p_reason:               input.reason,
    p_notes:                input.notes ?? null,
    p_system_user_id:       systemUserId,
    p_stock_location_id:    input.stock_location_id ?? null,
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
    p_supplier_id:          input.supplier_id ?? null,
    p_entry_type:           input.entry_type,
    p_quantity_original:    input.quantity_original,
    p_unit_cost:            input.unit_cost,
    p_freight_cost:         input.freight_cost ?? 0,
    p_tax_cost:             input.tax_cost ?? 0,
    p_entry_date:           input.entry_date,
    p_notes:                input.notes ?? null,
    p_system_user_id:       systemUserId,
    p_stock_location_id:    input.stock_location_id ?? null,
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

// ─── Transferência em massa entre locais ──────────────────────────────────────

export interface StockTransferBulkInputItem {
  product_variation_id: number
  quantity: number
}

export interface StockTransferBulkInput {
  from_location_id: number
  to_location_id:   number
  notes?:           string | null
  items:            StockTransferBulkInputItem[]
}

export interface StockTransferBulkItem {
  product_variation_id: number
  product_name:         string | null
  sku_variation:        string | null
  quantity:             number
  unit_cost:            number
  from_qty_before:      number
  from_qty_after:       number
  to_qty_before:        number
  to_qty_after:         number
  to_avg_cost_after:    number
}

export interface StockTransferBulkItemError {
  product_variation_id: number | null
  product_name:         string | null
  sku_variation:        string | null
  quantity_requested:   number | null
  balance_available:    number | null
  reason:               string
  suggestion:           string
}

export type StockTransferBulkOutcome =
  | {
      ok:               true
      batch_id:         string
      from_location_id: number
      to_location_id:   number
      total_items:      number
      total_quantity:   number
      transferred:      StockTransferBulkItem[]
    }
  | {
      ok:     false
      errors: StockTransferBulkItemError[]
    }

export async function transferStockBulk(
  input: StockTransferBulkInput,
  systemUserId: string
): Promise<ServiceOutcome<StockTransferBulkOutcome>> {
  const admin = createAdminClient()

  const { data, error } = await (admin as any).rpc('rpc_stock_transfer_bulk', {
    p_from_location_id: input.from_location_id,
    p_to_location_id:   input.to_location_id,
    p_notes:            input.notes ?? null,
    p_user_id:          systemUserId,
    p_items:            input.items,
  }) as unknown as {
    data:  StockTransferBulkOutcome | null
    error: { code: string; message: string } | null
  }

  if (error) {
    const status = error.code === 'P0001' ? 400 : 500
    return failure(error.message, status)
  }

  return success(data!)
}

// ─── Transferência individual entre locais ─────────────────────────────────────

export async function transferStock(
  input: StockTransferInput,
  systemUserId: string
): Promise<ServiceOutcome<StockTransferResult>> {
  const admin = createAdminClient()

  const { data, error } = await (admin as any).rpc('rpc_transfer_stock', {
    p_product_variation_id: input.product_variation_id,
    p_from_location_id:     input.from_location_id,
    p_to_location_id:       input.to_location_id,
    p_quantity:             input.quantity,
    p_notes:                input.notes ?? null,
    p_user_id:              systemUserId,
  }) as unknown as {
    data: StockTransferResult | null
    error: { code: string; message: string } | null
  }

  if (error) {
    const status = error.code === 'P0001' ? 400 : 500
    return failure(error.message, status)
  }

  return success(data!)
}
