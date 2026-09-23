/**
 * Serviço de sincronização de estoque ERP ↔ Nuvemshop.
 *
 * Para o site/Nuvemshop, envia o SALDO TOTAL somando todos os locais ativos
 * (stock_balances + stock_locations.active = true).
 * Para vendas presenciais, o estoque consumido é apenas o Estoque Loja.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { getNuvemshopProduct, isNuvemshopNotFound, updateVariantStock } from '@/lib/integrations/nuvemshop'
import { resolveNuvemshopContextForCompany, type NuvemshopContext } from '@/services/nuvemshop/context.service'
import {
  getNuvemshopVariantMapping,
  invalidateNuvemshopProductMapping,
  invalidateNuvemshopVariantMapping,
} from '@/services/nuvemshop/mappings.service'
import { getVariationAvailability, getAffectedSellableVariationIds } from '@/services/inventory/availability.service'
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
  /** 404 confirmado: vínculo morto removido (produto inteiro ou só a variante). */
  invalidated?: 'product' | 'variant'
}

// ─── Helper: quantidade vendável para o site ──────────────────────────────────

export type OnlineStockResult =
  | { ok: true; qty: number; source: 'legacy_stock_balances' | 'kit_availability' }
  | { ok: false; error: string }

/**
 * Erro de schema de kits ausente (migration 202609231000 não aplicada):
 * coluna `product_kind` inexistente. Só nesse caso o produto é tratado como
 * normal — qualquer outro erro é falha de verdade.
 */
function isKitsSchemaMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return error.code === '42703' && /product_kind/.test(error.message ?? '')
}

/**
 * Quantidade a publicar no site/Nuvemshop — FAIL-SAFE: nunca devolve 0 por
 * erro; quem chama não envia nada quando `ok: false`.
 *
 *   produto normal → lógica LEGADA, idêntica à anterior aos kits: soma de
 *                    stock_balances nos locais ativos (agora conferindo erro);
 *   kit            → camada central de disponibilidade
 *                    (`services/inventory/availability.service.ts`), só
 *                    quando `product_kind` existe e o produto é kit.
 * Sem a coluna `product_kind` (migration de kits ausente) não existem kits:
 * todo produto segue a lógica legada.
 */
export async function resolveOnlineStock(
  admin: SupabaseClient,
  companyId: number,
  productVariationId: number
): Promise<OnlineStockResult> {
  let isKit = false
  const { data: kindRow, error: kindErr } = await (admin as any)
    .from('product_variations')
    .select('id, products!inner(company_id, product_kind)')
    .eq('id', productVariationId)
    .eq('products.company_id', companyId)
    .maybeSingle() as {
      data: { products: { product_kind?: string | null } } | null
      error: { code?: string; message: string } | null
    }

  if (kindErr) {
    if (!isKitsSchemaMissing(kindErr)) return { ok: false, error: `tipo do produto: ${kindErr.message}` }
  } else if (!kindRow) {
    return { ok: false, error: 'variação não encontrada nesta empresa' }
  } else {
    isKit = kindRow.products.product_kind === 'kit'
  }

  if (isKit) {
    const availability = await getVariationAvailability(companyId, [productVariationId], 'online_priority')
    if (!availability.ok) return { ok: false, error: `disponibilidade do kit: ${availability.error}` }
    const row = availability.data.get(productVariationId)
    if (!row) return { ok: false, error: 'disponibilidade do kit não retornada' }
    return { ok: true, qty: row.sellable_quantity, source: 'kit_availability' }
  }

  const { data, error } = await (admin as any)
    .from('stock_balances')
    .select('quantity, stock_locations!inner(active)')
    .eq('product_variation_id', productVariationId)
    .eq('stock_locations.active', true) as unknown as {
      data: { quantity: number }[] | null
      error: { message: string } | null
    }
  if (error || !data) return { ok: false, error: `stock_balances: ${error?.message ?? 'sem resposta'}` }
  return { ok: true, qty: data.reduce((sum, row) => sum + (row.quantity ?? 0), 0), source: 'legacy_stock_balances' }
}

// ─── Função principal ─────────────────────────────────────────────────────────

/**
 * 404 no PUT de estoque = vínculo possivelmente morto. Confirma com GET do
 * produto remoto antes de invalidar:
 *   produto não existe → invalida o vínculo do produto inteiro;
 *   produto existe sem a variante → invalida só a variante (produto fica
 *   "inconsistente" na tela).
 * Depois disso a variação não tem mais mapping e deixa de ser enviada.
 */
async function handleStockPush404(
  ctx:                NuvemshopContext,
  productVariationId: number,
  mapping:            { produto_id: number; external_id: string; external_variant_id: string },
): Promise<'product' | 'variant' | null> {
  let remote
  try {
    remote = await getNuvemshopProduct(mapping.external_id, ctx.credentials)
  } catch (err) {
    console.error('[nuvemshopSyncService] 404 no estoque, mas não foi possível confirmar o produto remoto', { productVariationId, err })
    return null
  }

  if (!remote) {
    const inv = await invalidateNuvemshopProductMapping(ctx.companyId, mapping.produto_id, {
      expectedRemoteProductId: mapping.external_id, reason: 'stock_push_404_product',
    })
    return inv.ok ? 'product' : null
  }

  const variantExists = (remote.variants ?? []).some((v) => String(v.id) === String(mapping.external_variant_id))
  if (variantExists) return null
  const inv = await invalidateNuvemshopVariantMapping(ctx.companyId, productVariationId, {
    expectedRemoteVariantId: mapping.external_variant_id, reason: 'stock_push_404_variant',
  })
  return inv.ok ? 'variant' : null
}

export async function pushVariantStockToNuvemshop(
  productVariationId: number,
  options: NSSyncOptions = {}
): Promise<NSSyncResult> {
  const { eventType = 'stock_push_erp', externalOrderId } = options
  const admin = createAdminClient()

  // 1. Empresa dona da variação → contexto Nuvemshop da empresa
  const { data: owner, error: ownerErr } = await (admin as any)
    .from('product_variations')
    .select('id, products!inner(company_id)')
    .eq('id', productVariationId)
    .maybeSingle() as { data: { products: { company_id: number } } | null; error: { message: string } | null }
  if (ownerErr) return { success: false, skipped: false, error: `Falha ao buscar variação: ${ownerErr.message}` }
  if (!owner) return { success: true, skipped: true }

  const ctxRes = await resolveNuvemshopContextForCompany(owner.products.company_id)
  if (!ctxRes.ok) {
    // Empresa sem Nuvemshop → nada a sincronizar. Outros erros são reportados.
    if (ctxRes.status === 404) return { success: true, skipped: true }
    return { success: false, skipped: false, error: ctxRes.error }
  }
  const ctx = ctxRes.data

  // 2. Mapping da variação (escopado pela empresa)
  const mappingRes = await getNuvemshopVariantMapping(ctx.companyId, productVariationId)
  if (!mappingRes.ok) return { success: false, skipped: false, error: mappingRes.error }
  const mapping = mappingRes.data
  if (!mapping?.external_variant_id) {
    return { success: true, skipped: true }
  }

  // 3. Quantidade vendável online — sem valor seguro, NADA é enviado
  const stock = await resolveOnlineStock(admin as unknown as SupabaseClient, ctx.companyId, productVariationId)
  if (!stock.ok) {
    const error = `stock_resolution_failed: ${stock.error}`
    console.error('[nuvemshopSyncService] Estoque não determinado — PUT não enviado', { productVariationId, error })
    try {
      await (admin as any).from('nuvemshop_sync_logs').insert({
        event_type:           eventType,
        direction:            'erp_to_ns',
        product_variation_id: productVariationId,
        external_product_id:  mapping.external_id,
        external_variant_id:  mapping.external_variant_id,
        external_order_id:    externalOrderId ?? null,
        stock_after:          null,
        success:              false,
        error_message:        error,
      })
    } catch (logErr) {
      console.error('[nuvemshopSyncService] Erro ao gravar nuvemshop_sync_logs', logErr)
    }
    return { success: false, skipped: false, error }
  }
  const newQty = stock.qty

  // 4. Enviar estoque FINAL para Nuvemshop
  let success = false
  let errorMessage: string | undefined
  let invalidated: NSSyncResult['invalidated']

  try {
    await updateVariantStock(mapping.external_id, mapping.external_variant_id, newQty, ctx.credentials)
    success = true
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err)
    if (isNuvemshopNotFound(err)) {
      invalidated = (await handleStockPush404(ctx, productVariationId, {
        produto_id:          mapping.produto_id,
        external_id:         String(mapping.external_id),
        external_variant_id: String(mapping.external_variant_id),
      })) ?? undefined
    }
    console.error('[nuvemshopSyncService] Falha ao atualizar estoque na Nuvemshop', {
      productVariationId,
      external_variant_id: mapping.external_variant_id,
      newQty,
      invalidated: invalidated ?? null,
      error: errorMessage,
    })
  }

  // 5. Log
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
        metadata:             invalidated ? { mapping_invalidated: invalidated } : null,
      })
  } catch (logErr) {
    console.error('[nuvemshopSyncService] Erro ao gravar nuvemshop_sync_logs', logErr)
  }

  // 6. Atualizar timestamp
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

  return { success, skipped: false, newQty, error: errorMessage, invalidated }
}

/**
 * Sincroniza um conjunto de variações que mudaram de estoque. Expande para
 * TODAS as variações vendáveis afetadas (a própria, os componentes de um
 * kit vendido e os kits que dependem de um componente movimentado) via
 * camada central — variação sem mapeamento Nuvemshop é ignorada (skipped)
 * como sempre.
 */
export async function pushMultipleVariantStocksToNuvemshop(
  productVariationIds: number[],
  options: NSSyncOptions = {}
): Promise<void> {
  const ids = await expandAffectedVariations(productVariationIds)
  await Promise.allSettled(
    ids.map((id) =>
      pushVariantStockToNuvemshop(id, options).catch((err) =>
        console.error('[nuvemshopSyncService] Exceção não tratada ao sincronizar variação', { id, err })
      )
    )
  )
}

/** Variação + dependentes (kits/componentes); em erro, cai para a lista original. */
async function expandAffectedVariations(productVariationIds: number[]): Promise<number[]> {
  if (productVariationIds.length === 0) return []
  const admin = createAdminClient()
  const { data: owners } = await (admin as any)
    .from('product_variations')
    .select('id, products!inner(company_id)')
    .in('id', productVariationIds) as { data: Array<{ id: number; products: { company_id: number } }> | null }

  const byCompany = new Map<number, number[]>()
  for (const row of owners ?? []) {
    const list = byCompany.get(row.products.company_id) ?? []
    list.push(row.id)
    byCompany.set(row.products.company_id, list)
  }

  const out = new Set<number>(productVariationIds)
  for (const [companyId, ids] of byCompany) {
    const affected = await getAffectedSellableVariationIds(companyId, ids)
    if (affected.ok) affected.data.forEach((id) => out.add(id))
  }
  return [...out]
}
