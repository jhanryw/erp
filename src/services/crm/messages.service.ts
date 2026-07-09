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
 * applyProviderStatusUpdate() — mesma função pros dois lados do ciclo
 * (Entrega 6: a transição inicial 'pending'→'sent' do outbound é, na
 * prática, "status reportado pelo provider", só que chega de forma síncrona
 * em vez de por webhook assíncrono; passa pela mesma RPC da Entrega 5,
 * ganhando checagem de ordem + sent_at/failed_at + idempotência de graça).
 *
 * client_dedupe_key é a idempotência de CRIAÇÃO do lado outbound (clique
 * duplo/retry de frontend) — existe ANTES de qualquer resposta do provider,
 * por isso é uma chave separada de external_message_id (que só existe
 * depois do envio).
 *
 * Entregas 2–6 (Fase 3): create/get/list/findByExternalId/findByDedupeKey +
 * applyProviderStatusUpdate.
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
  /** Idempotência de criação outbound (Entrega 6) — nunca usado por inbound. */
  clientDedupeKey?: string | null
  /** Responder uma mensagem específica (Entrega 6). */
  replyToMessageId?: number | null
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
    if (error.message.includes('uq_crm_messages_client_dedupe_key')) {
      return { message: 'Mensagem já criada para esta client_dedupe_key nesta conversa.', status: 409 }
    }
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
      client_dedupe_key: input.clientDedupeKey ?? null,
      reply_to_message_id: input.replyToMessageId ?? null,
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

export interface ListMessagesOptions {
  /** Default 50 — Entrega 7 (Inbox) é o primeiro consumidor real desta função. */
  limit?: number
  /** Pagina pra trás (mensagens mais antigas que este id) — "carregar mais" no topo do thread. */
  beforeId?: number
}

const DEFAULT_MESSAGE_LIMIT = 50

/**
 * Lista mensagens de uma conversa. Busca as mais recentes primeiro
 * internamente (pra `beforeId` paginar de forma natural — "antes desta
 * mensagem"), mas devolve em ordem cronológica ascendente, pronta pra
 * renderizar direto num thread de chat sem o chamador precisar inverter.
 */
export async function listMessagesByConversation(
  conversationId: number,
  companyId: number,
  options?: ListMessagesOptions,
): Promise<ServiceOutcome<CrmMessage[]>> {
  const admin = createAdminClient()
  const limit = options?.limit ?? DEFAULT_MESSAGE_LIMIT

  let query = (admin as any)
    .from('crm_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('company_id', companyId)

  if (options?.beforeId) query = query.lt('id', options.beforeId)

  const { data, error } = await query
    .order('id', { ascending: false })
    .limit(limit) as unknown as { data: CrmMessage[] | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success((data ?? []).reverse())
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
 * Lookup de idempotência de CRIAÇÃO outbound (Entrega 6) — confirma se já
 * existe mensagem para esta client_dedupe_key nesta conversa, antes de
 * inserir (e antes de acionar o provider) ou como rede de segurança depois
 * de uma corrida perdida contra o índice único.
 */
export async function findMessageByDedupeKey(
  conversationId: number,
  clientDedupeKey: string,
  companyId: number,
): Promise<ServiceOutcome<CrmMessage | null>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('client_dedupe_key', clientDedupeKey)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: CrmMessage | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data)
}

// ─── Sincronização de status vindo do provider (Entregas 5-6) ─────────────────

export type ProviderMessageStatus = 'sent' | 'delivered' | 'read' | 'failed'

export interface ApplyProviderStatusResult {
  applied: boolean
  currentStatus: CrmMessageStatus
}

/**
 * Aplica um evento de status vindo do provider de forma atômica — a RPC
 * reavalia a condição de aceitação no momento do lock da linha (sem janela
 * entre leitura e escrita). Idempotente por construção: evento repetido ou
 * fora de ordem simplesmente não aplica (`applied: false`), nunca é tratado
 * como erro. `direction='outbound'` é reforçado dentro da RPC como defesa
 * em profundidade.
 *
 * Único ponto de escrita de status de todo o ciclo outbound — usada tanto
 * pelo webhook assíncrono de status (Entrega 5, message-status-sync.service.ts)
 * quanto pela confirmação síncrona do envio inicial (Entrega 6,
 * outbound-message.service.ts, que passa `externalMessageId` na transição
 * 'pending'→'sent'). Não existe um segundo caminho de escrita de status —
 * `updateMessageStatus()` (Entrega 2) foi removida por ficar sem uso real
 * depois que essa unificação ficou clara.
 */
export async function applyProviderStatusUpdate(
  messageId: number,
  companyId: number,
  newStatus: ProviderMessageStatus,
  occurredAt?: string | null,
  failureReason?: string | null,
  externalMessageId?: string | null,
): Promise<ServiceOutcome<ApplyProviderStatusResult>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any).rpc('rpc_apply_crm_message_status', {
    p_company_id: companyId,
    p_message_id: messageId,
    p_new_status: newStatus,
    p_occurred_at: occurredAt ?? null,
    p_failure_reason: failureReason ?? null,
    p_external_message_id: externalMessageId ?? null,
  }) as unknown as {
    data: { applied: boolean; current_status: CrmMessageStatus } | null
    error: { message: string } | null
  }

  if (error) return failure(error.message)
  if (!data) return failure('Falha ao aplicar status da mensagem.')

  return success({ applied: data.applied, currentStatus: data.current_status })
}
