/**
 * Service de CRM — Envio outbound de mensagem (Entrega 6).
 *
 * Ponto único que a rota POST /api/crm/conversations/[id]/messages chama.
 * Reaproveita integralmente as Entregas 1-5: getConversation()/
 * updateConversationStatus() (conversations.service.ts), getChannel()
 * (channels.service.ts), getChannelIdentity() (channel-identities.service.ts),
 * createMessage()/applyProviderStatusUpdate() (messages.service.ts),
 * getMediaByPublicId()/resolveMediaUrl()/createMediaUsage() (Media Hub) —
 * nenhuma regra nova nesses arquivos além das extensões já aditivas.
 *
 * Fluxo: valida posse da conversa → idempotência por client_dedupe_key →
 * valida mídia (se houver) → cria mensagem 'pending' → aciona o provider
 * (síncrono) → aplica 'sent'/'failed' via a MESMA RPC da Entrega 5.
 *
 * Sem outbound frio nesta entrega — sempre dentro de uma conversa já
 * existente (conversation_id vem da URL). company_id nunca aceito como
 * input — sempre a empresa da sessão do agente (a rota resolve isso via
 * requireRole() antes de chamar este service).
 */

import type { CrmMessage, CrmMessageContentType, Json } from '@/types/database.types'
import type { ServiceOutcome } from '../produtos.service'
import { getConversation, updateConversationStatus } from './conversations.service'
import { getChannel } from './channels.service'
import { getChannelIdentity } from './channel-identities.service'
import { createMessage, findMessageByDedupeKey, applyProviderStatusUpdate, getMessage } from './messages.service'
import { getMediaByPublicId, resolveMediaUrl, createMediaUsage } from '@/services/media.service'
import { getProvider } from './providers/registry'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface SendOutboundMessageInput {
  conversationId: number
  companyId: number
  userId: string
  content?: string | null
  contentType: CrmMessageContentType
  mediaPublicId?: string | null
  metadata?: Json | null
  replyToMessageId?: number | null
  clientDedupeKey: string
}

export interface SendOutboundMessageResult {
  message: CrmMessage
  deduplicated: boolean
  /** Erro reportado pelo provider no envio (sendResult.ok=false ou provider sem implementação). Nunca fica só no log. */
  providerError: string | null
  /** Erro ao gravar sent/failed no banco após o envio (RPC falhou) — mensagem pode ter sido enviada de verdade mas o ERP não conseguiu registrar. Nunca fica só no log. */
  statusUpdateError: string | null
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

/** content_type que representa arquivo exige media_public_id — nada pra enviar sem isso. */
const MEDIA_REQUIRED_CONTENT_TYPES: CrmMessageContentType[] = ['image', 'audio', 'video', 'document']

async function finalize(
  messageId: number,
  companyId: number,
  providerError: string | null = null,
  statusUpdateError: string | null = null,
): Promise<ServiceOutcome<SendOutboundMessageResult>> {
  const finalResult = await getMessage(messageId, companyId)
  if (!finalResult.ok) return failure(finalResult.error, finalResult.status)
  return success({ message: finalResult.data, deduplicated: false, providerError, statusUpdateError })
}

// ─── Operação ──────────────────────────────────────────────────────────────────

export async function sendOutboundMessage(
  input: SendOutboundMessageInput,
): Promise<ServiceOutcome<SendOutboundMessageResult>> {
  const conversationResult = await getConversation(input.conversationId, input.companyId)
  if (!conversationResult.ok) return failure(conversationResult.error, conversationResult.status)
  const conversation = conversationResult.data

  // Idempotência de criação: clique duplo/retry de frontend/timeout nunca
  // reenvia ao provider — se a client_dedupe_key já existe, devolve a
  // mensagem como está (mesmo que ainda 'pending'), nunca tenta de novo.
  const existing = await findMessageByDedupeKey(input.conversationId, input.clientDedupeKey, input.companyId)
  if (!existing.ok) return failure(existing.error)
  if (existing.data) {
    return success({ message: existing.data, deduplicated: true, providerError: null, statusUpdateError: null })
  }

  if (MEDIA_REQUIRED_CONTENT_TYPES.includes(input.contentType) && !input.mediaPublicId) {
    return failure(`content_type='${input.contentType}' exige media_public_id.`, 422)
  }

  let mediaId: number | null = null
  let mediaUrl: string | null = null
  let mediaMimeType: string | null = null

  if (input.mediaPublicId) {
    const media = await getMediaByPublicId(input.mediaPublicId, input.companyId)
    if (!media) return failure('Mídia não encontrada.', 404)
    if (!media.active) return failure('Mídia inativa não pode ser enviada.', 422)
    if (media.visibility !== 'private') {
      return failure('Mídia pública não pode ser anexada a mensagem de CRM — anexo de conversa é sempre privado.', 422)
    }

    const urlResult = await resolveMediaUrl(media)
    if (!urlResult.ok) return failure(urlResult.error, urlResult.status)

    mediaId = media.id
    mediaUrl = urlResult.data.url
    mediaMimeType = media.mime_type
  }

  const channelResult = await getChannel(conversation.channel_id, input.companyId)
  if (!channelResult.ok) return failure(channelResult.error, channelResult.status)
  const channel = channelResult.data
  if (!channel.active || channel.status !== 'active') {
    return failure(`Canal '${channel.name}' está inativo — não é possível enviar.`, 422)
  }

  const identityResult = await getChannelIdentity(conversation.channel_identity_id, input.companyId)
  if (!identityResult.ok) return failure(identityResult.error, identityResult.status)
  const identity = identityResult.data

  const messageResult = await createMessage({
    companyId: input.companyId,
    conversationId: input.conversationId,
    channelId: conversation.channel_id,
    personId: conversation.person_id,
    direction: 'outbound',
    status: 'pending',
    content: input.content ?? null,
    contentType: input.contentType,
    createdSource: 'manual',
    createdBy: input.userId,
    metadata: input.metadata ?? null,
    clientDedupeKey: input.clientDedupeKey,
    replyToMessageId: input.replyToMessageId ?? null,
  })

  if (!messageResult.ok) {
    // Corrida perdida contra outra chamada com a mesma client_dedupe_key.
    if (messageResult.status === 409) {
      const retried = await findMessageByDedupeKey(input.conversationId, input.clientDedupeKey, input.companyId)
      if (retried.ok && retried.data) {
        return success({ message: retried.data, deduplicated: true, providerError: null, statusUpdateError: null })
      }
    }
    return failure(messageResult.error, messageResult.status)
  }

  const message = messageResult.data

  if (mediaId) {
    const usageResult = await createMediaUsage(
      { mediaId, entityType: 'crm_message', entityId: String(message.id), role: 'attachment' },
      input.companyId,
      input.userId,
    )
    if (!usageResult.ok) {
      // Degradação graciosa (mesma filosofia da Entrega 4): a mensagem já
      // existe, só o vínculo de mídia falhou — não aborta o envio por isso.
      console.error('[sendOutboundMessage] Falha ao vincular mídia à mensagem', {
        messageId: message.id,
        mediaId,
        error: usageResult.error,
      })
    }
  }

  if (conversation.status === 'closed') {
    const reopenResult = await updateConversationStatus(conversation.id, input.companyId, 'open')
    if (!reopenResult.ok) {
      console.error('[sendOutboundMessage] Falha ao reabrir conversa', { conversationId: conversation.id, error: reopenResult.error })
    }
  }

  const provider = getProvider(channel.provider)
  if (!provider) {
    const providerErrorMsg = `Provider '${channel.provider}' não tem implementação de envio.`
    const failResult = await applyProviderStatusUpdate(message.id, input.companyId, 'failed', null, providerErrorMsg)
    if (!failResult.ok) {
      console.error('[sendOutboundMessage] Falha ao aplicar status failed (provider ausente)', { messageId: message.id, error: failResult.error })
    }
    // providerError sempre exposto (o problema é real, mesmo que a gravação de 'failed' tenha funcionado);
    // statusUpdateError só quando a própria gravação falhou — os dois nunca ficam só no console.error.
    return finalize(message.id, input.companyId, providerErrorMsg, failResult.ok ? null : failResult.error)
  }

  const sendResult = await provider.sendMessage({
    channel,
    recipientIdentityValue: identity.value,
    content: input.content ?? null,
    contentType: input.contentType,
    mediaUrl,
    mediaMimeType,
    metadata: input.metadata ?? null,
    idempotencyKey: input.clientDedupeKey,
  })

  const statusResult = sendResult.ok
    ? await applyProviderStatusUpdate(message.id, input.companyId, 'sent', null, null, sendResult.providerMessageId ?? null)
    : await applyProviderStatusUpdate(message.id, input.companyId, 'failed', null, sendResult.errorMessage ?? 'Falha ao enviar mensagem.')

  if (!statusResult.ok) {
    console.error('[sendOutboundMessage] Falha ao aplicar status pós-envio', {
      messageId: message.id,
      sendOk: sendResult.ok,
      error: statusResult.error,
    })
  }

  return finalize(
    message.id,
    input.companyId,
    sendResult.ok ? null : (sendResult.errorMessage ?? 'Falha ao enviar mensagem.'),
    statusResult.ok ? null : statusResult.error,
  )
}
