/**
 * Serviço de sincronização de estoque ERP ↔ Nuvemshop.
 *
 * Função principal: pushVariantStockToNuvemshop
 *   - Busca estoque atual no ERP (fonte de verdade)
 *   - Envia quantidade FINAL para a Nuvemshop (não delta)
 *   - Registra log em nuvemshop_sync_logs
 *   - Atualiza last_stock_synced_at em produto_map
 *
 * Estratégia anti-loop:
 *   - ERP sale → push final qty → NS (PUT quantity, não cria pedido → sem webhook loop)
 *   - NS webhook → deduct ERP → confirm final qty → NS (mesma direção, sem loop)
 *   - Nuvemshop só dispara webhooks para pedidos, nunca para atualizações de stock
 *
 * Uso:
 *   import { pushVariantStockToNuvemshop } from '@/lib/services/nuvemshopSyncService'
 *   await pushVariantStockToNuvemshop(variation_id)
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { updateVariantStock } from '@/lib/integrations/nuvemshop'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface NSSyncOptions {
  /**
   * Tipo do evento para fins de log.
   *   'stock_push_erp'   = Venda feita no ERP → sincroniza para NS
   *   'stock_confirm_ns' = Webhook NS processado → confirma qtd final de volta para NS
   */
  eventType?: 'stock_push_erp' | 'stock_confirm_ns'
  /** ID do pedido externo (opcional, para rastreabilidade em eventos NS) */
  externalOrderId?: string
}

export interface NSSyncResult {
  success:  boolean
  /** true quando variação não tem mapeamento NS — não é erro, apenas sem ação */
  skipped:  boolean
  newQty?:  number
  error?:   string
}

// ─── Função principal ─────────────────────────────────────────────────────────

/**
 * Envia o estoque atual de uma variação do ERP para a variante correspondente
 * na Nuvemshop.
 *
 * Silencioso quando não há mapeamento (skipped=true, success=true).
 * Nunca lança exceção — erros são retornados em result.error e logados.
 */
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

  // Variação ainda não enviada para a Nuvemshop — sem ação necessária
  if (!mapping?.external_variant_id) {
    return { success: true, skipped: true }
  }

  // 2. Buscar saldo atual no ERP (fonte de verdade)
  const { data: stockRow } = await admin
    .from('stock')
    .select('quantity')
    .eq('product_variation_id', productVariationId)
    .maybeSingle() as unknown as { data: { quantity: number } | null }

  const newQty = stockRow?.quantity ?? 0

  // 3. Enviar estoque FINAL para Nuvemshop (não delta — reduz drift entre sistemas)
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

  // 4. Registrar log da sincronização (não-fatal se falhar)
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

  // 5. Atualizar timestamp de última sincronização (apenas se sucesso)
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

/**
 * Sincroniza o estoque de múltiplas variações em paralelo.
 * Usado após vendas ERP com múltiplos itens.
 * Falhas individuais são logadas mas não interrompem as outras.
 */
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
