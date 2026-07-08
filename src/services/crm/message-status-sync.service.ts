/**
 * Service de CRM — Sincronização de status de mensagem vindo do provider
 * (Entrega 5: Evolution → N8N → ERP). Fecha o ciclo de mensagens outbound
 * (sent/delivered/read/failed) sem envio real existir ainda nesta fase.
 *
 * Reaproveita integralmente o que já existe: findChannelByProviderInstance()
 * e a política de canal inativo/inexistente = erro permanente 422 (mesma
 * de inbound-ingestion.service.ts), findMessageByExternalId() (Entrega 3).
 *
 * "Não encontrada" / "não é outbound" / "status obsoleto" NÃO são erro —
 * são resultado válido (`applied: false` + `reason`), sempre 200. Só canal
 * ausente/inativo é erro permanente (422) — é o único caso realmente
 * acionável por um humano corrigindo configuração.
 */

import type { ProviderMessageStatus } from './messages.service'
import type { CrmMessageStatus } from '@/types/database.types'
import type { ServiceOutcome } from '../produtos.service'
import { findChannelByProviderInstance } from './channels.service'
import { findMessageByExternalId } from './messages.service'
import { applyProviderStatusUpdate } from './messages.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface SyncMessageStatusInput {
  providerInstanceIdentifier: string
  externalMessageId: string
  status: ProviderMessageStatus
  occurredAt?: string | null
  errorMessage?: string | null
}

export type SyncMessageStatusReason = 'not_found' | 'not_outbound' | 'stale_status'

export interface SyncMessageStatusResult {
  applied: boolean
  reason: SyncMessageStatusReason | null
  messageId: number | null
  currentStatus: CrmMessageStatus | null
  companyId: number
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

// ─── Operação ──────────────────────────────────────────────────────────────────

export async function syncMessageStatus(
  input: SyncMessageStatusInput,
): Promise<ServiceOutcome<SyncMessageStatusResult>> {
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

  const messageResult = await findMessageByExternalId(channel.id, input.externalMessageId, channel.company_id)
  if (!messageResult.ok) return failure(messageResult.error)

  const message = messageResult.data
  if (!message) {
    return success({
      applied: false,
      reason: 'not_found',
      messageId: null,
      currentStatus: null,
      companyId: channel.company_id,
    })
  }

  if (message.direction !== 'outbound') {
    return success({
      applied: false,
      reason: 'not_outbound',
      messageId: message.id,
      currentStatus: message.status,
      companyId: channel.company_id,
    })
  }

  const applyResult = await applyProviderStatusUpdate(
    message.id,
    channel.company_id,
    input.status,
    input.occurredAt ?? null,
    input.errorMessage ?? null,
  )
  if (!applyResult.ok) return failure(applyResult.error)

  return success({
    applied: applyResult.data.applied,
    reason: applyResult.data.applied ? null : 'stale_status',
    messageId: message.id,
    currentStatus: applyResult.data.currentStatus,
    companyId: channel.company_id,
  })
}
