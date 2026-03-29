/**
 * Service de Estoque — lógica de negócio desacoplada de HTTP.
 *
 * Responsabilidade: ajustes manuais e entradas de lote com cálculo de
 * custo médio ponderado. Ambas as operações são transações lógicas
 * (não DB transactions — Supabase não expõe BEGIN/COMMIT via REST).
 *
 * Evolução: migrar para RPC PL/pgSQL transacional para garantir atomicidade.
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

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): { ok: true; data: T; error?: never; status?: never } {
  return { ok: true, data }
}

function failure(error: string, status = 500): { ok: false; error: string; status: number; data?: never } {
  return { ok: false, error, status }
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
 * Transação lógica: stock upsert → finance_entry (somente em saída).
 * Risco de falha parcial: se finance_entry falhar após stock upsert,
 * o estoque estará correto mas sem lançamento financeiro.
 * Evolução: migrar para RPC PL/pgSQL transacional.
 */
export async function adjustStock(
  input: StockAdjustInput,
  systemUserId: string
): Promise<ServiceOutcome<StockAdjustResult>> {
  const admin = createAdminClient() // admin client: write multi-tabela stock + finance_entries

  // Ler posição atual
  const { data: stockData, error: stockReadError } = await admin
    .from('stock')
    .select('quantity, avg_cost')
    .eq('product_variation_id', input.product_variation_id)
    .maybeSingle() as unknown as {
      data: { quantity: number; avg_cost: number } | null
      error: { message: string } | null
    }

  if (stockReadError) return failure(stockReadError.message)

  const currentQty = Number(stockData?.quantity ?? 0)
  const currentAvgCost = Number(stockData?.avg_cost ?? 0)
  const newQty = currentQty + input.delta

  if (newQty < 0) {
    return failure(
      `Estoque insuficiente. Atual: ${currentQty}, ajuste: ${input.delta}.`,
      400
    )
  }

  // Atualizar posição
  const { error: upsertError } = await admin.from('stock').upsert(
    {
      product_variation_id: input.product_variation_id,
      quantity: newQty,
      avg_cost: currentAvgCost,
      last_updated: new Date().toISOString(),
    } as any,
    { onConflict: 'product_variation_id' }
  )

  if (upsertError) return failure(upsertError.message)

  // Saída → lançamento de despesa (custo médio × unidades retiradas)
  if (input.delta < 0) {
    const amount = parseFloat((Math.abs(input.delta) * currentAvgCost).toFixed(2))
    const { error: financeError } = await admin.from('finance_entries').insert({
      type:           'expense',
      category:       'other_expense',
      description:    `Ajuste de estoque (${input.reason}): ${Math.abs(input.delta)} un. — var. #${input.product_variation_id}`,
      amount,
      reference_date: new Date().toISOString().slice(0, 10),
      notes:          input.notes ?? null,
      created_by:     systemUserId,
    } as any)

    if (financeError) return failure(financeError.message)
  }

  return success({ new_quantity: newQty, previous_quantity: currentQty, delta: input.delta })
}

// ─── Entrada de lote ──────────────────────────────────────────────────────────

/**
 * Registra uma entrada de estoque via lote (compra NF, bonificação, produção própria).
 *
 * Custo médio ponderado:
 *   new_avg = (prev_qty × prev_avg + new_qty × cost_per_unit) / (prev_qty + new_qty)
 *
 * Transação lógica: stock_lot insert → stock upsert → finance_entry.
 * Risco de falha parcial: lote pode ficar órfão se stock/finance falharem.
 * Evolução: migrar para RPC PL/pgSQL transacional.
 */
export async function createStockEntry(
  input: StockEntryInput,
  systemUserId: string
): Promise<ServiceOutcome<StockEntryResult>> {
  const admin = createAdminClient() // admin client: write multi-tabela stock_lots + stock + finance_entries

  const freightCost = input.freight_cost ?? 0
  const taxCost = input.tax_cost ?? 0
  const totalLotCost = input.unit_cost * input.quantity_original + freightCost + taxCost
  const costPerUnit = totalLotCost / input.quantity_original

  // 1. Criar lote de estoque
  const { data: lot, error: lotError } = await admin
    .from('stock_lots')
    .insert({
      product_variation_id: input.product_variation_id,
      supplier_id:          input.supplier_id ?? null,
      entry_type:           input.entry_type,
      quantity_original:    input.quantity_original,
      quantity_remaining:   input.quantity_original,
      unit_cost:            input.unit_cost,
      freight_cost:         freightCost,
      tax_cost:             taxCost,
      total_lot_cost:       totalLotCost,
      cost_per_unit:        costPerUnit,
      entry_date:           input.entry_date,
      notes:                input.notes ?? null,
      created_by:           systemUserId,
    } as any)
    .select('id')
    .single() as unknown as {
      data: { id: string } | null
      error: { message: string } | null
    }

  if (lotError || !lot) return failure(lotError?.message ?? 'Erro ao criar lote de estoque.')

  // 2. Atualizar posição de estoque (custo médio ponderado)
  const { data: currentStock, error: stockReadError } = await admin
    .from('stock')
    .select('quantity, avg_cost')
    .eq('product_variation_id', input.product_variation_id)
    .maybeSingle() as unknown as {
      data: { quantity: number; avg_cost: number } | null
      error: { message: string } | null
    }

  if (stockReadError) return failure(stockReadError.message)

  const prevQty      = Number(currentStock?.quantity ?? 0)
  const prevAvgCost  = Number(currentStock?.avg_cost ?? 0)
  const newQty       = prevQty + input.quantity_original
  const newAvgCost   = newQty > 0
    ? (prevQty * prevAvgCost + input.quantity_original * costPerUnit) / newQty
    : costPerUnit

  const { error: stockError } = await admin.from('stock').upsert(
    {
      product_variation_id: input.product_variation_id,
      quantity:             newQty,
      avg_cost:             newAvgCost,
      last_updated:         new Date().toISOString(),
    } as any,
    { onConflict: 'product_variation_id' }
  )

  if (stockError) return failure(stockError.message)

  // 3. Lançamento financeiro (custo total da entrada)
  const { error: financeError } = await admin.from('finance_entries').insert({
    type:           'expense',
    category:       'stock_purchase',
    description:    `Entrada de estoque — Lote #${lot.id}`,
    amount:         totalLotCost,
    reference_date: input.entry_date,
    stock_lot_id:   lot.id,
    created_by:     systemUserId,
  } as any)

  if (financeError) return failure(financeError.message)

  return success({
    lot_id:         lot.id,
    new_quantity:   newQty,
    new_avg_cost:   newAvgCost,
    total_lot_cost: totalLotCost,
    cost_per_unit:  costPerUnit,
  })
}
