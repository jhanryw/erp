/**
 * Service de CRM — Orquestração da ingestão inbound de mensagem
 * (Entrega 3: texto/idempotência; Entrega 4: mídia via Media Hub).
 *
 * Ponto único que a rota POST /api/automations/crm/inbound-message chama.
 * Reaproveita quase tudo das entregas anteriores (findOrCreateConversation,
 * createMessage, findMessageByExternalId, createMediaFromUpload,
 * createMediaUsage) — nunca a rota humana do Media Hub, sempre chamada
 * direta de função (service_role), mesmo padrão já usado em
 * produtos/[id]/page.tsx chamando listMediaByEntity() direto.
 *
 * company_id nunca é aceito como input — é sempre derivado do canal
 * resolvido (channel.company_id).
 *
 * Anexo de mídia é degradação graciosa, não erro de request: se o MIME não
 * é permitido ou o arquivo excede o limite, a mensagem ainda é criada
 * (histórico não se perde), só sem anexo — `media: null` + `mediaError`
 * no retorno avisam o motivo.
 *
 * Idempotência de mensagem (external_message_id) foi estendida na Entrega 4:
 * se o webhook reenviar e a mensagem já existir MAS ainda não tiver mídia
 * anexada (falha parcial anterior), tenta anexar agora em vez de só
 * retornar deduplicated=true sem mais nada — decisão do usuário.
 */

import type {
  CrmChannelType,
  CrmMessageContentType,
  CrmPersonCreatedSource,
  Json,
} from '@/types/database.types'
import type { ServiceOutcome } from '../produtos.service'
import { resolveActiveChannelByProviderInstance } from './channels.service'
import { normalizeChannelIdentityValue, findOrCreateChannelIdentity } from './channel-identities.service'
import { findOrCreateConversation } from './conversations.service'
import { findMessageByExternalId, createMessage } from './messages.service'
import {
  computeChecksumSha256,
  findActiveMediaByChecksum,
  createMediaFromUpload,
  createMediaUsage,
  listMediaByEntity,
} from '@/services/media.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface IngestInboundMediaInput {
  mimeType: string
  fileSize: number
  base64Content: string
  fileName?: string | null
}

/** Snapshot limitado da mensagem citada (Entrega 3) — nunca duplica mídia. */
export interface IngestInboundQuotedMessageInput {
  externalMessageId: string
  contentType: CrmMessageContentType
  contentPreview?: string | null
  senderIdentityValue?: string | null
}

export interface IngestInboundMessageInput {
  providerInstanceIdentifier: string
  senderIdentityValue: string
  senderDisplayName?: string | null
  externalMessageId: string
  content?: string | null
  contentType: CrmMessageContentType
  n8nExecutionId?: string | null
  metadata?: Json | null
  media?: IngestInboundMediaInput | null
  /** Resolve reply_to_message_id via lookup por external_message_id no mesmo canal. */
  replyToExternalMessageId?: string | null
  /** Fallback gravado em metadata.quoted_message só quando a mensagem original não é encontrada. */
  quotedMessage?: IngestInboundQuotedMessageInput | null
}

export interface IngestedMediaRef {
  publicId: string
}

export interface IngestInboundMessageResult {
  messageId: number
  conversationId: number
  personId: number
  channelId: number
  companyId: number
  deduplicated: boolean
  media: IngestedMediaRef | null
  mediaError: string | null
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

/**
 * Sobe (ou reusa por checksum) a mídia e vincula à mensagem via
 * media_usages(entity_type='crm_message', role='attachment'). Nunca lança —
 * qualquer falha vira { mediaError } para o chamador decidir a resposta
 * (degradação graciosa, mensagem já existe independente do resultado aqui).
 */
async function attachMediaToMessage(
  companyId: number,
  messageId: number,
  media: IngestInboundMediaInput,
): Promise<{ media: IngestedMediaRef | null; mediaError: string | null }> {
  let buffer: Buffer
  try {
    buffer = Buffer.from(media.base64Content, 'base64')
  } catch {
    return { media: null, mediaError: 'invalid_base64' }
  }
  if (buffer.byteLength === 0) {
    return { media: null, mediaError: 'empty_file' }
  }

  const checksum = computeChecksumSha256(buffer)
  const reuse = await findActiveMediaByChecksum(companyId, checksum, 'private')

  let mediaRow = reuse.ok ? reuse.data : null

  if (!mediaRow) {
    const uploadResult = await createMediaFromUpload(
      {
        buffer,
        mimeType: media.mimeType,
        fileName: media.fileName?.trim() || 'anexo-inbound',
        visibility: 'private',
        createdSource: 'channel_inbound',
      },
      companyId,
      null,
    )
    if (!uploadResult.ok) {
      // 422 = MIME/tamanho não permitido pelo Media Hub, 502 = falha de
      // Storage — nos dois casos é degradação graciosa, não erro de request.
      return { media: null, mediaError: uploadResult.status === 422 ? 'unsupported_media' : 'upload_failed' }
    }
    mediaRow = uploadResult.data
  }

  const usageResult = await createMediaUsage(
    { mediaId: mediaRow.id, entityType: 'crm_message', entityId: String(messageId), role: 'attachment' },
    companyId,
    null,
  )
  if (!usageResult.ok) {
    return { media: null, mediaError: 'attach_failed' }
  }

  return { media: { publicId: mediaRow.public_id }, mediaError: null }
}

/**
 * Mensagem já existe (idempotência) — resolve o retorno considerando se já
 * tem mídia (deduplicado de verdade) ou se precisa retomar um anexo que
 * ficou pendente numa tentativa anterior.
 */
async function resolveExistingMessage(
  existingMessageId: number,
  companyId: number,
  mediaInput: IngestInboundMediaInput | null | undefined,
): Promise<{ media: IngestedMediaRef | null; mediaError: string | null }> {
  if (!mediaInput) return { media: null, mediaError: null }

  const already = await listMediaByEntity('crm_message', String(existingMessageId), companyId)
  if (already.ok && already.data.length > 0) {
    const first = already.data[0]
    return { media: { publicId: first.public_id }, mediaError: null }
  }

  return attachMediaToMessage(companyId, existingMessageId, mediaInput)
}

/**
 * Resolve reply_to_message_id via lookup por external_message_id no mesmo
 * canal (Entrega 3). Nunca falha a ingestão: se a mensagem citada ainda não
 * existe (fora de ordem, de outro canal, ou nunca ingerida), não há vínculo
 * estrutural — grava só o snapshot enviado pelo N8N em metadata.quoted_message
 * como fallback visual, sem duplicar conteúdo completo nem mídia.
 */
async function resolveReplyAndQuotedMessage(
  channelId: number,
  companyId: number,
  baseMetadata: Json | null | undefined,
  replyToExternalMessageId: string | null | undefined,
  quotedMessage: IngestInboundQuotedMessageInput | null | undefined,
): Promise<{ replyToMessageId: number | null; metadata: Json | null }> {
  if (!replyToExternalMessageId) {
    return { replyToMessageId: null, metadata: baseMetadata ?? null }
  }

  const lookup = await findMessageByExternalId(channelId, replyToExternalMessageId, companyId)
  if (lookup.ok && lookup.data) {
    return { replyToMessageId: lookup.data.id, metadata: baseMetadata ?? null }
  }

  if (!quotedMessage) {
    return { replyToMessageId: null, metadata: baseMetadata ?? null }
  }

  const base = baseMetadata && typeof baseMetadata === 'object' && !Array.isArray(baseMetadata)
    ? (baseMetadata as Record<string, unknown>)
    : {}

  return {
    replyToMessageId: null,
    metadata: {
      ...base,
      quoted_message: {
        external_message_id: quotedMessage.externalMessageId,
        content_type: quotedMessage.contentType,
        content_preview: quotedMessage.contentPreview ?? null,
        sender_identity_value: quotedMessage.senderIdentityValue ?? null,
      },
    } as Json,
  }
}

// ─── Operação ──────────────────────────────────────────────────────────────────

export async function ingestInboundMessage(
  input: IngestInboundMessageInput,
): Promise<ServiceOutcome<IngestInboundMessageResult>> {
  const channelResult = await resolveActiveChannelByProviderInstance(input.providerInstanceIdentifier)
  if (!channelResult.ok) return failure(channelResult.error, channelResult.status)
  const channel = channelResult.data

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
    const { media, mediaError } = await resolveExistingMessage(existing.data.id, channel.company_id, input.media)
    return success({
      messageId: existing.data.id,
      conversationId: conversation.id,
      personId,
      channelId: channel.id,
      companyId: channel.company_id,
      deduplicated: true,
      media,
      mediaError,
    })
  }

  const { replyToMessageId, metadata } = await resolveReplyAndQuotedMessage(
    channel.id,
    channel.company_id,
    input.metadata,
    input.replyToExternalMessageId,
    input.quotedMessage,
  )

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
    metadata,
    replyToMessageId,
  })

  if (!messageResult.ok) {
    // Corrida perdida contra uma reentrega concorrente do mesmo external_message_id
    // — não é erro real, é o mesmo caso de idempotência acima chegando por outro caminho.
    if (messageResult.status === 409) {
      const retried = await findMessageByExternalId(channel.id, input.externalMessageId, channel.company_id)
      if (retried.ok && retried.data) {
        const { media, mediaError } = await resolveExistingMessage(retried.data.id, channel.company_id, input.media)
        return success({
          messageId: retried.data.id,
          conversationId: conversation.id,
          personId,
          channelId: channel.id,
          companyId: channel.company_id,
          deduplicated: true,
          media,
          mediaError,
        })
      }
    }
    return failure(messageResult.error, messageResult.status)
  }

  let media: IngestedMediaRef | null = null
  let mediaError: string | null = null
  if (input.media) {
    const attached = await attachMediaToMessage(channel.company_id, messageResult.data.id, input.media)
    media = attached.media
    mediaError = attached.mediaError
  }

  return success({
    messageId: messageResult.data.id,
    conversationId: conversation.id,
    personId,
    channelId: channel.id,
    companyId: channel.company_id,
    deduplicated: false,
    media,
    mediaError,
  })
}
