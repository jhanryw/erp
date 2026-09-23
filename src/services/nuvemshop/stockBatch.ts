/**
 * Seleção de lote do "Sincronizar Estoque Pendente" (puro).
 *
 * Pendente = variação mapeada nunca sincronizada (last_stock_synced_at NULL).
 * Avança por cursor (product_variation_id crescente), então uma variação que
 * falha sempre é visitada UMA vez por execução e o processo termina — antes
 * a falha ficava eternamente no topo da fila (NULL first) e o loop da UI
 * nunca chegava a remaining = 0.
 */

import type { NuvemshopMappingRow } from './mappings.service'

export interface PendingStockBatch {
  variationIds: number[]
  nextCursor:   number
  done:         boolean
}

export function selectPendingStockBatch(rows: NuvemshopMappingRow[], cursor: number, limit: number): PendingStockBatch {
  const pending = [...new Set(
    rows
      .filter((r) => r.product_variation_id != null && r.external_variant_id != null && r.last_stock_synced_at == null)
      .map((r) => r.product_variation_id as number)
      .filter((id) => id > cursor),
  )].sort((a, b) => a - b)

  const variationIds = pending.slice(0, limit)
  return {
    variationIds,
    nextCursor: variationIds.length > 0 ? variationIds[variationIds.length - 1] : cursor,
    done:       pending.length <= limit,
  }
}

/** Variações mapeadas (com variante remota) — para os syncs completos. */
export function mappedVariationIds(rows: NuvemshopMappingRow[]): number[] {
  return [...new Set(rows.filter((r) => r.product_variation_id != null && r.external_variant_id != null).map((r) => r.product_variation_id as number))]
}
