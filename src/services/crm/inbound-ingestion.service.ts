/**
 * Service de CRM — Orquestração da ingestão inbound de mensagem (Entrega 3).
 *
 * Ponto único que a rota POST /api/automations/crm/inbound-message chama.
 * Reaproveita quase tudo das Entregas 1/2 (findOrCreateConversation,
 * createMessage, findMessageByExternalId) — o que é novo aqui é só a
 * resolução de canal por instância e a atomicidade pessoa+identidade.
 *
 * company_id nunca é aceito como input — é sempre derivado do canal
 * resolvido (channel.company_id), a partir daí é a única fonte de verdade
 * para todo o resto da cadeia.
 *
 * Canal não encontrado ou inativo é erro PERMANENTE de configuração — a
 * rota HTTP responde 422 (não 404) para não induzir retry-loop em
 * N8N/Evolution, decisão do usuário. Este service só sinaliza via
 * ServiceOutcome; a tradução pra status HTTP específico é responsabilidade
 * da rota (mas já retorna 422 aqui, então a rota só repassa).
 */

import type { CrmChannelType, CrmMessageContentType, CrmPersonCreatedSource } from '@/types/database.types'
import type { ServiceOutcome } from '../produtos.service'
import { findChannelByProviderInstance } from './channels.service'
import { normalizeChannelIdentityValue, findOrCreateChannelIdentity } from './channel-identities.service'
import { findOrCreateConversation } from './conversations.service'
import { findMessageByExternalId, createMessage } from './messages.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface IngestInboundMessageInput {
  providerInstanceIdentifier: string
  senderIdentityValue: string
  senderDisplayName?: string | null
  externalMessageId: string
  content?: string | null
  contentType: CrmMessageContentType
  n8nExecutionId?: string | null
}

export interface IngestInboundMessageResult {
  messageId: number
  conversationId: number
  personId: number
  channelId: number
  companyId: number
  deduplicated: boolean
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

/**
 * `created_source` de crm_persons não tem um valor "_inbound" para todo
 * channel_type (só whatsapp_inbound/instagram_inbound existem hoje,
 * decisão da Entrega 1) — canais sem valor específico caem em 'other'.
 * Não é alteração de schema, é só mapeamento do que já existe.
 */
function personCreatedSourceForChannel(channelType: CrmChannelType): CrmPersonCreatedSource {
  switch (channelType) {
    case 'whatsapp':
      return 'whatsapp_inbound'
    case 'instagram':
      return 'instagram_inbound'
    case 'mercado_livre':
    case 'shopee':
      return 'marketplace_sync'
    default:
      return 'other'
  }
}

// ─── Operação ──────────────────────────────────────────────────────────────────

export async function ingestInboundMessage(
  input: IngestInboundMessageInput,
): Promise<ServiceOutcome<IngestInboundMessageResult>> {
  const channelResult = await findChannelByProviderInstance(input.providerInstanceIdentifier)
  if (!channelResult.ok) return failure(channelResult.error)

  const channel = channelResult.data
  if (!channel) {
    return failure(
      `Canal não encontrado para provider_instance_identifier='${input.providerInstanceIdentifier}'. ` +
      'Erro permanente de configuração — não reenviar sem cadastrar/corrigir o canal.',
      422,
    )
  }
  if (!channel.active || channel.status !== 'active') {
    return failure(
      `Canal '${channel.name}' encontrado mas inativo (active=${channel.active}, status=${channel.status}). ` +
      'Erro permanente de configuração — não reenviar até o canal ser reativado.',
      422,
    )
  }

  const normalizedValue = normalizeChannelIdentityValue(channel.channel_type, input.senderIdentityValue)
  if (!normalizedValue) {
    return failure('sender_identity_value inválido (vazio após normalização).', 422)
  }

  const identityResult = await findOrCreateChannelIdentity({
    companyId: channel.company_id,
    channelType: channel.channel_type,
    value: normalizedValue,
    displayNameHint: input.senderDisplayName ?? null,
    personCreatedSource: personCreatedSourceForChannel(channel.channel_type),
    identityCreatedSource: 'inbound_message',
  })
  if (!identityResult.ok) return failure(identityResult.error, identityResult.status)
  const { personId, channelIdentityId } = identityResult.data

  const conversationResult = await findOrCreateConversation({
    companyId: channel.company_id,
    channelId: channel.id,
    channelIdentityId,
    personId,
  })
  if (!conversationResult.ok) return failure(conversationResult.error, conversationResult.status)
  const conversation = conversationResult.data

  // Idempotência primária: mensagem do provider já ingerida (reentrega de webhook).
  const existing = await findMessageByExternalId(channel.id, input.externalMessageId, channel.company_id)
  if (!existing.ok) return failure(existing.error)
  if (existing.data) {
    return success({
      messageId: existing.data.id,
      conversationId: conversation.id,
      personId,
      channelId: channel.id,
      companyId: channel.company_id,
      deduplicated: true,
    })
  }

  const messageResult = await createMessage({
    companyId: channel.company_id,
    conversationId: conversation.id,
    channelId: channel.id,
    personId,
    direction: 'inbound',
    status: 'received',
    content: input.content ?? null,
    contentType: input.contentType,
    externalMessageId: input.externalMessageId,
    n8nExecutionId: input.n8nExecutionId ?? null,
    createdSource: 'inbound_webhook',
  })

  if (!messageResult.ok) {
    // Corrida perdida contra uma reentrega concorrente do mesmo external_message_id
    // — não é erro real, é o mesmo caso de idempotência acima chegando por outro caminho.
    if (messageResult.status === 409) {
      const retried = await findMessageByExternalId(channel.id, input.externalMessageId, channel.company_id)
      if (retried.ok && retried.data) {
        return success({
          messageId: retried.data.id,
          conversationId: conversation.id,
          personId,
          channelId: channel.id,
          companyId: channel.company_id,
          deduplicated: true,
        })
      }
    }
    return failure(messageResult.error, messageResult.status)
  }

  return success({
    messageId: messageResult.data.id,
    conversationId: conversation.id,
    personId,
    channelId: channel.id,
    companyId: channel.company_id,
    deduplicated: false,
  })
}
