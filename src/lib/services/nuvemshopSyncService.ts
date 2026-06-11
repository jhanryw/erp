/**
 * Serviço de sincronização de estoque ERP ↔ Nuvemshop.
 *
 * Para o site/Nuvemshop, envia o SALDO TOTAL somando todos os locais ativos
 * (stock_balances + stock_locations.active = true).
 * Para vendas presenciais, o estoque consumido é apenas o Estoque Loja.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { updateVariantStock } from '@/lib/integrations/nuvemshop'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface NSSyncOptions {
  eventType?: 'stock_push_erp' | 'stock_confirm_ns'
  externalOrderId?: string
}

export interface NSSyncResult {
  success:  boolean
  skipped:  boolean
  newQty?:  number
  error?:   string
}

// ─── Helper: saldo total para o site (soma todos os locais ativos) ────────────

/**
 * Retorna a soma de stock_balances.quantity de todos os locais ativos
 * da empresa à qual a variação pertence.
 * Este é o saldo a exibir no site/Nuvemshop.
 */
export async function getTotalStockForOnlineSales(
  admin: SupabaseClient,
  productVariationId: number
): Promise<number> {
  const { data } = await (admin as any)
    .from('stock_balances')
    .select('quantity, stock_locations!inner(active)')
    .eq('product_variation_id', productVariationId)
    .eq('stock_locations.active', true) as unknown as {
      data: { quantity: number }[] | null
    }

  return (data ?? []).reduce((sum, row) => sum + (row.quantity ?? 0), 0)
}

// ─── Função principal ─────────────────────────────────────────────────────────

export async function pushVariantStockToNuvemshop(
  productVariationId: number,
  options: NSSyncOptions = {}
): Promise<NSSyncResult> {
  const { eventType = 'stock_push_erp', externalOrderId } = options
  const admin = createAdminClient()

  // 1. Buscar mapeamento NS para esta variação
  const { data: mapping } = await (admin as any)
    .from('produto_map')
    .select('external_id, external_variant_id')
    .eq('product_variation_id', productVariationId)
    .eq('source', 'nuvemshop')
    .maybeSingle() as {
      data: { external_id: string; external_variant_id: string | null } | null
    }

  if (!mapping?.external_variant_id) {
    return { success: true, skipped: true }
  }

  // 2. Saldo total para o site = soma de todos os locais ativos
  const newQty = await getTotalStockForOnlineSales(admin as unknown as SupabaseClient, productVariationId)

  // 3. Enviar estoque FINAL para Nuvemshop
  let success = false
  let errorMessage: string | undefined

  try {
    await updateVariantStock(mapping.external_id, mapping.external_variant_id, newQty)
    success = true
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err)
    console.error('[nuvemshopSyncService] Falha ao atualizar estoque na Nuvemshop', {
      productVariationId,
      external_variant_id: mapping.external_variant_id,
      newQty,
      error: errorMessage,
    })
  }

  // 4. Log
  try {
    await (admin as any)
      .from('nuvemshop_sync_logs')
      .insert({
        event_type:           eventType,
        direction:            'erp_to_ns',
        product_variation_id: productVariationId,
        external_product_id:  mapping.external_id,
        external_variant_id:  mapping.external_variant_id,
        external_order_id:    externalOrderId ?? null,
        stock_after:          newQty,
        success,
        error_message:        errorMessage ?? null,
      })
  } catch (logErr) {
    console.error('[nuvemshopSyncService] Erro ao gravar nuvemshop_sync_logs', logErr)
  }

  // 5. Atualizar timestamp
  if (success) {
    try {
      await (admin as any)
        .from('produto_map')
        .update({ last_stock_synced_at: new Date().toISOString() })
        .eq('product_variation_id', productVariationId)
        .eq('source', 'nuvemshop')
    } catch (tsErr) {
      console.error('[nuvemshopSyncService] Erro ao atualizar last_stock_synced_at', tsErr)
    }
  }

  return { success, skipped: false, newQty, error: errorMessage }
}

export async function pushMultipleVariantStocksToNuvemshop(
  productVariationIds: number[],
  options: NSSyncOptions = {}
): Promise<void> {
  await Promise.allSettled(
    productVariationIds.map((id) =>
      pushVariantStockToNuvemshop(id, options).catch((err) =>
        console.error('[nuvemshopSyncService] Exceção não tratada ao sincronizar variação', { id, err })
      )
    )
  )
}
