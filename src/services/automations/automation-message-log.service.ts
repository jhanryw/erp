/**
 * FASE N2B — Idempotência + auditoria de `POST /api/automations/chatwoot/send`.
 *
 * Padrão "claim antes de processar" (mesmo espírito de
 * `rpc_claim_outbox_events`/`rpc_claim_event_deliveries`, Fases 2/4): o
 * chamador reivindica a `idempotency_key` ANTES de enviar a mensagem de
 * verdade. Se outra chamada (retry do n8n) já reivindicou a mesma chave e
 * já terminou com sucesso, esta função nunca deixa o chamador reenviar —
 * fecha a janela de corrida que um "SELECT antes, INSERT depois" simples
 * deixaria aberta.
 *
 * Ver `supabase/migrations/20260817_automation_message_log.sql` pra
 * justificativa de por que esta tabela é nova (não reaproveita
 * `post_sale_automation_events`, semanticamente amarrada ao pós-venda v2).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { ServiceOutcome } from '../produtos.service'

export type AutomationMessageResult = 'pending' | 'sent' | 'failed' | 'duplicate'

export interface AutomationMessageLogRow {
  id: number
  company_id: number
  automation_name: string
  customer_id: number
  sale_id: number | null
  idempotency_key: string | null
  channel: 'chatwoot'
  result: AutomationMessageResult
  conversation_id: string | null
  external_message_id: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface ClaimAutomationMessageInput {
  companyId: number
  automationName: string
  customerId: number
  saleId?: number | null
  idempotencyKey?: string | null
}

export type ClaimAutomationMessageResult =
  /** Nenhuma chave, ou chave nova — chamador deve prosseguir e enviar. */
  | { status: 'claimed'; logId: number }
  /** Chave já teve um envio bem-sucedido antes — NUNCA reenviar. */
  | { status: 'duplicate'; log: AutomationMessageLogRow }
  /** Chave está sendo processada por outra chamada concorrente agora mesmo — não é seguro reenviar nem temos resultado final ainda. */
  | { status: 'in_progress' }

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

export async function claimAutomationMessage(
  input: ClaimAutomationMessageInput,
): Promise<ServiceOutcome<ClaimAutomationMessageResult>> {
  const admin = createAdminClient()

  const insertResult = await (admin as any)
    .from('automation_message_log')
    .insert({
      company_id: input.companyId,
      automation_name: input.automationName,
      customer_id: input.customerId,
      sale_id: input.saleId ?? null,
      idempotency_key: input.idempotencyKey ?? null,
      result: 'pending',
    })
    .select('*')
    .single() as { data: AutomationMessageLogRow | null; error: { code?: string; message: string } | null }

  if (!insertResult.error) return success({ status: 'claimed', logId: insertResult.data!.id })

  // Sem idempotency_key, o índice único não se aplica — qualquer erro aqui é
  // infra de verdade, nunca corrida de idempotência.
  if (!input.idempotencyKey || insertResult.error.code !== '23505') {
    return failure(insertResult.error.message)
  }

  const { data: existing, error: fetchError } = await (admin as any)
    .from('automation_message_log')
    .select('*')
    .eq('company_id', input.companyId)
    .eq('idempotency_key', input.idempotencyKey)
    .maybeSingle() as { data: AutomationMessageLogRow | null; error: { message: string } | null }

  if (fetchError) return failure(fetchError.message)
  if (!existing) return failure('Corrida de idempotência não resolvida: linha esperada não encontrada.')

  if (existing.result === 'sent') return success({ status: 'duplicate', log: existing })
  if (existing.result === 'pending') return success({ status: 'in_progress' })

  // result === 'failed' — tentativa anterior não foi bem-sucedida, permite
  // retry reaproveitando a MESMA linha (nunca cria uma segunda pra mesma
  // chave, o índice único não deixaria de qualquer forma).
  const { data: retried, error: retryError } = await (admin as any)
    .from('automation_message_log')
    .update({ result: 'pending', error_message: null, updated_at: new Date().toISOString() })
    .eq('id', existing.id)
    .eq('company_id', input.companyId)
    .select('*')
    .single() as { data: AutomationMessageLogRow | null; error: { message: string } | null }

  if (retryError) return failure(retryError.message)
  return success({ status: 'claimed', logId: retried!.id })
}

export interface MarkAutomationMessageSentInput {
  logId: number
  companyId: number
  conversationId: string | number
  externalMessageId: string
}

export async function markAutomationMessageSent(input: MarkAutomationMessageSentInput): Promise<ServiceOutcome<void>> {
  const admin = createAdminClient()
  const { error } = await (admin as any)
    .from('automation_message_log')
    .update({
      result: 'sent',
      conversation_id: String(input.conversationId),
      external_message_id: input.externalMessageId,
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.logId)
    .eq('company_id', input.companyId)

  if (error) return failure(error.message)
  return success(undefined)
}

export interface MarkAutomationMessageFailedInput {
  logId: number
  companyId: number
  errorMessage: string
}

export async function markAutomationMessageFailed(input: MarkAutomationMessageFailedInput): Promise<ServiceOutcome<void>> {
  const admin = createAdminClient()
  const { error } = await (admin as any)
    .from('automation_message_log')
    .update({ result: 'failed', error_message: input.errorMessage, updated_at: new Date().toISOString() })
    .eq('id', input.logId)
    .eq('company_id', input.companyId)

  if (error) return failure(error.message)
  return success(undefined)
}
