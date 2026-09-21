/**
 * ÚNICA regra de vendabilidade do catálogo de atacado.
 *
 * Catálogo, detalhe do produto e validação de carrinho usam SÓ as funções
 * deste módulo — nenhum outro arquivo decide preço de atacado, estoque
 * elegível ou "pode vender". Uma variação é vendável no atacado quando:
 *
 *   product.active
 *   && product.wholesale_enabled
 *   && variation.active
 *   && preço de atacado válido (override da variação ?? preço do produto, > 0)
 *   && estoque de atacado > 0
 *
 * Preço de atacado NUNCA cai no preço de varejo. `wholesale_enabled`
 * (participação no canal) é independente de `wholesale_price` (preço).
 *
 * Estoque de atacado (regra TEMPORÁRIA, centralizada aqui): soma de
 * `stock_balances.quantity` das `stock_locations` ativas da empresa — mesmo
 * escopo que a Nuvemshop recebe e que o débito online consome. Quando a
 * empresa definir quais locais abastecem o atacado, só esta função muda.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { selectAllInChunks } from './queryBatching'

// ─── Preço ──────────────────────────────────────────────────────────────────

/** Preço de atacado válido = número finito > 0. `null` quando não há (ou é inválido). */
export function resolveWholesalePrice(
  productWholesalePrice: number | string | null | undefined,
  variationWholesalePriceOverride: number | string | null | undefined,
): number | null {
  // Override da variação tem prioridade; só cai no do produto quando ausente
  // (null/undefined) — um override presente mas inválido NÃO cai no produto
  // (evita mascarar dado errado com outro preço).
  const raw = variationWholesalePriceOverride ?? productWholesalePrice
  if (raw == null || raw === '') return null
  const price = Number(raw)
  return Number.isFinite(price) && price > 0 ? price : null
}

// ─── Estoque ────────────────────────────────────────────────────────────────

interface StockRow {
  product_variation_id: number
  quantity: number | string | null
}

/** Soma o estoque de atacado por variação. Único ponto que define "estoque elegível". */
export async function loadWholesaleStockByVariation(
  admin: SupabaseClient,
  companyId: number,
  variationIds: number[],
): Promise<Record<number, number>> {
  const rows = await selectAllInChunks<StockRow, number>(variationIds, (chunk, from, to) =>
    (admin as any)
      .from('stock_balances')
      .select('product_variation_id, quantity, stock_locations!inner(company_id, active)')
      .in('product_variation_id', chunk)
      .eq('stock_locations.company_id', companyId)
      .eq('stock_locations.active', true)
      .order('product_variation_id', { ascending: true })
      .order('stock_location_id', { ascending: true })
      .range(from, to),
  )

  const byVariation: Record<number, number> = {}
  for (const row of rows) {
    byVariation[row.product_variation_id] = (byVariation[row.product_variation_id] ?? 0) + Number(row.quantity ?? 0)
  }
  return byVariation
}

// ─── Vendabilidade ──────────────────────────────────────────────────────────

export type WholesaleUnsellableReason =
  | 'product_inactive'
  | 'not_enabled'
  | 'variation_inactive'
  | 'no_wholesale_price'
  | 'out_of_stock'

export type WholesaleSellability =
  | { sellable: true; price: number; stock: number }
  | { sellable: false; reason: WholesaleUnsellableReason; price: number | null; stock: number }

export interface SellabilityInput {
  product: {
    active: boolean
    wholesale_enabled: boolean
    wholesale_price: number | string | null
  }
  variation: {
    active: boolean
    wholesale_price_override: number | string | null
  }
  /** Estoque de atacado da variação (ver `loadWholesaleStockByVariation`). */
  stock: number
}

export function evaluateWholesaleSellability({ product, variation, stock }: SellabilityInput): WholesaleSellability {
  const price = resolveWholesalePrice(product.wholesale_price, variation.wholesale_price_override)

  if (!product.active) return { sellable: false, reason: 'product_inactive', price, stock }
  if (!product.wholesale_enabled) return { sellable: false, reason: 'not_enabled', price, stock }
  if (!variation.active) return { sellable: false, reason: 'variation_inactive', price, stock }
  if (price == null) return { sellable: false, reason: 'no_wholesale_price', price: null, stock }
  if (!(stock > 0)) return { sellable: false, reason: 'out_of_stock', price, stock }

  return { sellable: true, price, stock }
}

export function isWholesaleSellable(input: SellabilityInput): boolean {
  return evaluateWholesaleSellability(input).sellable
}
