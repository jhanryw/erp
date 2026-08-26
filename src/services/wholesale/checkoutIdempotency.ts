/**
 * Idempotência do checkout do site de atacado — Fase 8, seção 39 do
 * pedido ("duplo clique não pode criar duas vendas").
 *
 * Claim atômico simples sobre `wholesale_checkout_idempotency`
 * (UNIQUE(idempotency_key)) — mesmo espírito de `rpc_claim_fiscal_
 * emission` (Fase Fiscal 3B: reserva a chave ANTES de fazer o trabalho
 * real, nunca depois), sem reaproveitar aquela tabela (escopo diferente
 * — emissão fiscal, não criação de venda).
 *
 * Fluxo:
 *   1. `claimIdempotencyKey` — INSERT; sucesso = "sou o primeiro, pode
 *      prosseguir". Falha por unique_violation = alguém já está
 *      processando esta chave (ou já terminou) — busca o estado atual e
 *      devolve pro chamador decidir (nunca cria uma segunda venda).
 *   2. `completeIdempotencyKey` — grava o resultado (sale_id ou erro)
 *      depois que `createSale` retornar.
 */

import { createAdminClient } from '@/lib/supabase/admin'

export type ClaimResult =
  | { decision: 'claimed' }
  | { decision: 'already_completed'; saleId: number }
  | { decision: 'already_processing' }
  | { decision: 'already_failed'; errorMessage: string | null }

export async function claimIdempotencyKey(
  idempotencyKey: string,
  companyId: number,
  customerId: number,
): Promise<ClaimResult> {
  const admin = createAdminClient()

  const { error: insertError } = await (admin as any)
    .from('wholesale_checkout_idempotency')
    .insert({ idempotency_key: idempotencyKey, company_id: companyId, customer_id: customerId })

  if (!insertError) return { decision: 'claimed' }

  // unique_violation (código 23505) — chave já existe, busca o estado atual.
  const { data: existing } = await (admin as any)
    .from('wholesale_checkout_idempotency')
    .select('status, sale_id, error_message')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle() as { data: { status: string; sale_id: number | null; error_message: string | null } | null }

  if (!existing) {
    // Corrida rara (linha sumiu entre o INSERT falhar e este SELECT — não
    // deveria acontecer, não há DELETE nesta tabela): trata como
    // "processando", nunca cria uma segunda venda por engano.
    return { decision: 'already_processing' }
  }

  if (existing.status === 'completed' && existing.sale_id) {
    return { decision: 'already_completed', saleId: existing.sale_id }
  }
  if (existing.status === 'failed') {
    return { decision: 'already_failed', errorMessage: existing.error_message }
  }
  return { decision: 'already_processing' }
}

export async function completeIdempotencyKey(idempotencyKey: string, saleId: number): Promise<void> {
  const admin = createAdminClient()
  await (admin as any)
    .from('wholesale_checkout_idempotency')
    .update({ status: 'completed', sale_id: saleId, completed_at: new Date().toISOString() })
    .eq('idempotency_key', idempotencyKey)
}

export async function failIdempotencyKey(idempotencyKey: string, errorMessage: string): Promise<void> {
  const admin = createAdminClient()
  await (admin as any)
    .from('wholesale_checkout_idempotency')
    .update({ status: 'failed', error_message: errorMessage, completed_at: new Date().toISOString() })
    .eq('idempotency_key', idempotencyKey)
}
