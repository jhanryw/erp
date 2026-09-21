/**
 * Ações em massa do ERP sobre o canal de atacado dos produtos:
 *   - ativar/desativar `wholesale_enabled`;
 *   - definir `wholesale_price` como um percentual do preço de varejo
 *     (ação EXPLÍCITA — nunca disparada automaticamente ao ativar).
 *
 * Tenant: TODA operação valida que cada id pertence à empresa do usuário
 * ANTES de escrever, e os UPDATEs ainda repetem `company_id` no filtro
 * (defesa em profundidade). Um id de outra empresa (ou inexistente) aborta
 * a requisição inteira sem alterar nada.
 *
 * Preço em massa não toca `wholesale_price_override` das variações (só
 * informa quantos overrides existem — sobrescrevê-los exige decisão
 * própria).
 */

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { auditLog } from '@/lib/audit/log'
import { selectAllInChunks } from './queryBatching'

export const BULK_MAX_PRODUCT_IDS = 200

export const bulkProductsSchema = z.object({
  product_ids: z.array(z.number().int().positive()).min(1, 'Selecione ao menos um produto.').max(BULK_MAX_PRODUCT_IDS, `No máximo ${BULK_MAX_PRODUCT_IDS} produtos por vez.`),
  changes: z.object({
    wholesale_enabled: z.boolean().optional(),
    /** Percentual do preço de varejo (ex.: 70 → 70%). Máx. 2 casas decimais. */
    wholesale_price_percent: z.number().min(1).max(100).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9, 'Use no máximo 2 casas decimais.').optional(),
  }).strict().refine((c) => c.wholesale_enabled !== undefined || c.wholesale_price_percent !== undefined, 'Informe ao menos uma alteração.'),
}).strict()

export type BulkProductsInput = z.infer<typeof bulkProductsSchema>

/** `base_price × percent%` em centavos inteiros, arredondado (meio pra cima) — exato para NUMERIC(10,2). */
export function computeWholesalePriceFromPercent(basePrice: number, percent: number): number {
  const cents = Math.round(basePrice * 100)
  const percentBasisPoints = Math.round(percent * 100)
  return Math.round((cents * percentBasisPoints) / 10000) / 100
}

export type BulkOutcome =
  | { ok: true; updated: number; enabledChanged: boolean; pricedProducts: number; variationOverridesUntouched: number }
  | { ok: false; status: number; error: string }

interface OwnedProduct { id: number; base_price: number; wholesale_enabled: boolean; wholesale_price: number | null }

export async function applyBulkWholesaleChanges(
  admin: SupabaseClient,
  ctx: { companyId: number; userId: string; userRole: string },
  input: BulkProductsInput,
): Promise<BulkOutcome> {
  const ids = Array.from(new Set(input.product_ids))
  const { changes } = input

  // ── Tenant: todos os ids precisam ser produtos DESTA empresa ─────────────
  const { data: owned, error: ownedError } = await (admin as any)
    .from('products')
    .select('id, base_price, wholesale_enabled, wholesale_price')
    .eq('company_id', ctx.companyId)
    .in('id', ids) as { data: OwnedProduct[] | null; error: { message: string } | null }

  if (ownedError) return { ok: false, status: 500, error: 'Falha ao validar os produtos selecionados.' }

  const ownedById = new Map((owned ?? []).map((p) => [p.id, p]))
  const missing = ids.filter((id) => !ownedById.has(id))
  if (missing.length > 0) {
    return { ok: false, status: 404, error: `Produto(s) não encontrado(s): ${missing.join(', ')}. Nenhuma alteração foi feita.` }
  }

  // ── wholesale_enabled ─────────────────────────────────────────────────────
  if (changes.wholesale_enabled !== undefined) {
    const { error } = await (admin as any)
      .from('products')
      .update({ wholesale_enabled: changes.wholesale_enabled })
      .in('id', ids)
      .eq('company_id', ctx.companyId) as { error: { message: string } | null }
    if (error) return { ok: false, status: 500, error: 'Falha ao atualizar os produtos.' }
  }

  // ── wholesale_price = base_price × percentual (agrupa por preço final) ───
  let pricedProducts = 0
  let variationOverridesUntouched = 0
  const newPrices = new Map<number, number>()
  if (changes.wholesale_price_percent !== undefined) {
    const groups = new Map<number, number[]>()
    for (const p of owned ?? []) {
      const price = computeWholesalePriceFromPercent(Number(p.base_price), changes.wholesale_price_percent)
      if (!(price > 0)) continue // nunca grava preço inválido (CHECK > 0)
      newPrices.set(p.id, price)
      const group = groups.get(price) ?? []
      group.push(p.id)
      groups.set(price, group)
    }

    for (const [price, groupIds] of groups) {
      const { error } = await (admin as any)
        .from('products')
        .update({ wholesale_price: price })
        .in('id', groupIds)
        .eq('company_id', ctx.companyId) as { error: { message: string } | null }
      if (error) return { ok: false, status: 500, error: 'Falha ao atualizar o preço de atacado.' }
      pricedProducts += groupIds.length
    }

    const variations = await selectAllInChunks<{ product_id: number; wholesale_price_override: number | null }, number>(ids, (chunk, from, to) =>
      (admin as any)
        .from('product_variations')
        .select('id, product_id, wholesale_price_override')
        .in('product_id', chunk)
        .order('id', { ascending: true })
        .range(from, to),
    )
    variationOverridesUntouched = variations.filter((v) => v.wholesale_price_override != null).length
  }

  for (const p of owned ?? []) {
    auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'update', resource: 'product', resourceId: p.id,
      before: { wholesale_enabled: p.wholesale_enabled, wholesale_price: p.wholesale_price },
      after: {
        wholesale_enabled: changes.wholesale_enabled ?? p.wholesale_enabled,
        wholesale_price: newPrices.get(p.id) ?? p.wholesale_price,
      },
      detail: 'Alteração em massa do atacado',
    })
  }

  return {
    ok: true,
    updated: ids.length,
    enabledChanged: changes.wholesale_enabled !== undefined,
    pricedProducts,
    variationOverridesUntouched,
  }
}
