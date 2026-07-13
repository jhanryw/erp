/**
 * Service de CRM — Reactions (crm_message_reactions), Entrega 5.
 *
 * Uma reaction não é uma crm_messages — sem `content`, sem ciclo de status
 * de entrega, ciclo de vida próprio (criar/trocar/remover). Tabela e
 * orquestração isoladas.
 *
 * Confirmação técnica (protocolo WhatsApp/Baileys, ver cabeçalho da
 * migration 20260717_crm_message_reactions.sql): no máximo 1 reação ativa
 * por pessoa por mensagem — reagir de novo SUBSTITUI, emoji vazio REMOVE.
 * upsertReaction()/removeReaction() são idempotentes por construção via
 * UNIQUE(message_id, channel_identity_id): reenviar o mesmo evento nunca
 * falha, só reaplica o mesmo estado.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { ServiceOutcome } from '../produtos.service'
import { resolveActiveChannelByProviderInstance } from './channels.service'
import { normalizeChannelIdentityValue, findOrCreateChannelIdentity } from './channel-identities.service'
import { findMessageByExternalId } from './messages.service'
import { personCreatedSourceForChannel } from './inbound-ingestion.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface UpsertReactionInput {
  companyId: number
  messageId: number
  channelIdentityId: number
  emoji: string
}

export interface RemoveReactionInput {
  companyId: number
  messageId: number
  channelIdentityId: number
}

export interface ReactionRow {
  id: number
  emoji: string
}

export interface IngestInboundReactionInput {
  providerInstanceIdentifier: string
  externalMessageId: string
  reactorIdentityValue: string
  /** Vazio/null = remover a reação existente. */
  emoji?: string | null
}

export type IngestInboundReactionReason = 'message_not_found'

export interface IngestInboundReactionResult {
  applied: boolean
  reason: IngestInboundReactionReason | null
  removed: boolean
  messageId: number | null
  reactionId: number | null
  companyId: number
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

// ─── CRUD ──────────────────────────────────────────────────────────────────────

/** Cria a reação, ou troca o emoji se já existir uma da mesma pessoa nesta mensagem. */
export async function upsertReaction(input: UpsertReactionInput): Promise<ServiceOutcome<ReactionRow>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_message_reactions')
    .upsert(
      {
        company_id: input.companyId,
        message_id: input.messageId,
        channel_identity_id: input.channelIdentityId,
        emoji: input.emoji,
        updated_at: new Date().toISOString(),
      } as any,
      { onConflict: 'message_id,channel_identity_id' },
    )
    .select('id, emoji')
    .single() as unknown as { data: ReactionRow | null; error: { message: string } | null }

  if (error) return failure(error.message)
  if (!data) return failure('Falha ao registrar reação.')
  return success(data)
}

/** Remove a reação da pessoa nesta mensagem, se existir — idempotente (nada encontrado não é erro). */
export async function removeReaction(input: RemoveReactionInput): Promise<ServiceOutcome<{ removed: boolean }>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_message_reactions')
    .delete()
    .eq('company_id', input.companyId)
    .eq('message_id', input.messageId)
    .eq('channel_identity_id', input.channelIdentityId)
    .select('id') as unknown as { data: { id: number }[] | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success({ removed: (data?.length ?? 0) > 0 })
}

// ─── Operação ──────────────────────────────────────────────────────────────────

/**
 * Ponto único chamado pela rota POST /api/automations/crm/inbound-reaction.
 * "Mensagem não encontrada" NÃO é erro — mesma disciplina de
 * message-status-sync.service.ts (`applied: false` + `reason`, sempre 200):
 * a reação pode legitimamente chegar antes da mensagem original ser
 * ingerida (reordenação de webhook), e não há como criar um vínculo
 * estrutural sem o message_id existir.
 */
export async function ingestInboundReaction(
  input: IngestInboundReactionInput,
): Promise<ServiceOutcome<IngestInboundReactionResult>> {
  const channelResult = await resolveActiveChannelByProviderInstance(input.providerInstanceIdentifier)
  if (!channelResult.ok) return failure(channelResult.error, channelResult.status)
  const channel = channelResult.data

  const messageResult = await findMessageByExternalId(channel.id, input.externalMessageId, channel.company_id)
  if (!messageResult.ok) return failure(messageResult.error)
  if (!messageResult.data) {
    return success({
      applied: false,
      reason: 'message_not_found',
      removed: false,
      messageId: null,
      reactionId: null,
      companyId: channel.company_id,
    })
  }
  const message = messageResult.data

  const normalizedValue = normalizeChannelIdentityValue(channel.channel_type, input.reactorIdentityValue)
  if (!normalizedValue) {
    return failure('reactor_identity_value inválido (vazio após normalização).', 422)
  }

  const identityResult = await findOrCreateChannelIdentity({
    companyId: channel.company_id,
    channelType: channel.channel_type,
    value: normalizedValue,
    displayNameHint: null,
    personCreatedSource: personCreatedSourceForChannel(channel.channel_type),
    identityCreatedSource: 'inbound_message',
  })
  if (!identityResult.ok) return failure(identityResult.error, identityResult.status)
  const { channelIdentityId } = identityResult.data

  const emoji = input.emoji?.trim() || null

  if (!emoji) {
    const removeResult = await removeReaction({
      companyId: channel.company_id,
      messageId: message.id,
      channelIdentityId,
    })
    if (!removeResult.ok) return failure(removeResult.error, removeResult.status)
    return success({
      applied: true,
      reason: null,
      removed: true,
      messageId: message.id,
      reactionId: null,
      companyId: channel.company_id,
    })
  }

  const upsertResult = await upsertReaction({
    companyId: channel.company_id,
    messageId: message.id,
    channelIdentityId,
    emoji,
  })
  if (!upsertResult.ok) return failure(upsertResult.error, upsertResult.status)

  return success({
    applied: true,
    reason: null,
    removed: false,
    messageId: message.id,
    reactionId: upsertResult.data.id,
    companyId: channel.company_id,
  })
}
