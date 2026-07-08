/**
 * Service de CRM — Mensagens (crm_messages).
 *
 * channel_id é redundante com crm_conversations.channel_id (decisão
 * explícita: idempotência de (channel_id, external_message_id), performance
 * e auditoria sem depender de join) — createMessage() confirma que os dois
 * batem antes de inserir, para o campo redundante nunca divergir do dono.
 *
 * status combina os dois sentidos numa única coluna: inbound nasce
 * 'received' (sem ciclo de envio), outbound nasce 'pending' e evolui via
 * updateMessageStatus(). Sem colunas sent_at/delivered_at/read_at nesta
 * entrega — status_updated_at cobre a última transição.
 *
 * Entrega 2 (Fase 3): create/get/list/updateStatus + findByExternalId
 * (lookup de idempotência). Sem consumidor ainda.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type {
  CrmMessage,
  CrmMessageDirection,
  CrmMessageStatus,
  CrmMessageContentType,
  CrmMessageCreatedSource,
  Json,
} from '@/types/database.types'
import type { ServiceOutcome } from '../produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface CreateCrmMessageInput {
  companyId: number
  conversationId: number
  channelId: number
  personId: number
  direction: CrmMessageDirection
  status: CrmMessageStatus
  content?: string | null
  contentType: CrmMessageContentType
  externalMessageId?: string | null
  n8nExecutionId?: string | null
  createdSource: CrmMessageCreatedSource
  createdBy?: string | null
  /** Payload estruturado sem arquivo — localização, vCard, tipo futuro não mapeado (Entrega 4). */
  metadata?: Json | null
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

function uniqueViolation(error: { code?: string; message: string }): { message: string; status: number } {
  if (error.code === '23505') {
    return { message: 'Mensagem já registrada (external_message_id ou n8n_execution_id duplicado).', status: 409 }
  }
  return { message: error.message, status: 500 }
}

// ─── Verificação de coerência ──────────────────────────────────────────────────

/**
 * Confirma que conversation_id/channel_id/person_id informados batem com a
 * conversa dona — o channel_id de crm_messages é redundante por decisão
 * explícita, mas nunca deveria divergir do channel_id da própria conversa.
 */
async function messageMatchesConversation(
  conversationId: number,
  channelId: number,
  personId: number,
  companyId: number,
): Promise<boolean> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('crm_conversations')
    .select('id, channel_id, person_id')
    .eq('id', conversationId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: { id: number; channel_id: number; person_id: number } | null }

  if (!data) return false
  return data.channel_id === channelId && data.person_id === personId
}

// ─── Operações ─────────────────────────────────────────────────────────────────

export async function createMessage(input: CreateCrmMessageInput): Promise<ServiceOutcome<CrmMessage>> {
  const matches = await messageMatchesConversation(input.conversationId, input.channelId, input.personId, input.companyId)
  if (!matches) {
    return failure('conversation_id/channel_id/person_id não são coerentes com a conversa informada.', 422)
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_messages')
    .insert({
      company_id: input.companyId,
      conversation_id: input.conversationId,
      channel_id: input.channelId,
      person_id: input.personId,
      direction: input.direction,
      status: input.status,
      content: input.content ?? null,
      content_type: input.contentType,
      external_message_id: input.externalMessageId ?? null,
      n8n_execution_id: input.n8nExecutionId ?? null,
      created_source: input.createdSource,
      created_by: input.createdBy ?? null,
      metadata: input.metadata ?? null,
    } as any)
    .select('*')
    .single() as unknown as { data: CrmMessage | null; error: { code?: string; message: string } | null }

  if (error) {
    const { message, status } = uniqueViolation(error)
    return failure(message, status)
  }
  return success(data!)
}

export async function getMessage(messageId: number, companyId: number): Promise<ServiceOutcome<CrmMessage>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_messages')
    .select('*')
    .eq('id', messageId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: CrmMessage | null; error: { message: string } | null }

  if (error) return failure(error.message)
  if (!data) return failure('Mensagem não encontrada.', 404)
  return success(data)
}

export async function listMessagesByConversation(
  conversationId: number,
  companyId: number,
): Promise<ServiceOutcome<CrmMessage[]>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: true }) as unknown as { data: CrmMessage[] | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data ?? [])
}

/**
 * Lookup de idempotência de ingestão — confirma se uma mensagem do provider
 * já foi gravada antes de inserir de novo (reentrega de webhook).
 */
export async function findMessageByExternalId(
  channelId: number,
  externalMessageId: string,
  companyId: number,
): Promise<ServiceOutcome<CrmMessage | null>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_messages')
    .select('*')
    .eq('channel_id', channelId)
    .eq('external_message_id', externalMessageId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: CrmMessage | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data)
}

/**
 * Progressão de status (ex.: 'pending' → 'sent'/'failed' quando o N8N
 * confirma o envio real). Sem consumidor ainda — endpoint de callback fica
 * para a Entrega 3.
 */
export async function updateMessageStatus(
  messageId: number,
  companyId: number,
  patch: { status: CrmMessageStatus; failureReason?: string | null; externalMessageId?: string | null },
): Promise<ServiceOutcome<void>> {
  const admin = createAdminClient()
  const { error } = await (admin as any)
    .from('crm_messages')
    .update({
      status: patch.status,
      status_updated_at: new Date().toISOString(),
      failure_reason: patch.failureReason ?? null,
      ...(patch.externalMessageId !== undefined ? { external_message_id: patch.externalMessageId } : {}),
    })
    .eq('id', messageId)
    .eq('company_id', companyId) as { error: { code?: string; message: string } | null }

  if (error) {
    const { message, status } = uniqueViolation(error)
    return failure(message, status)
  }
  return success(undefined)
}
