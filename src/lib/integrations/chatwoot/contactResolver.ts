/**
 * Resolução de contato do Chatwoot → crm_person (Fase 3 — Chatwoot Inbound).
 *
 * Reaproveita integralmente a infraestrutura já existente — nenhuma tabela
 * nova, nenhuma segunda "tabela de pessoas":
 *   - crm_persons / crm_channel_identities (Fase 3 do CRM, 2026-07)
 *   - rpc_find_or_create_crm_person_by_identity, via findOrCreateChannelIdentity
 *     (mesmo advisory lock que já protege contra concorrência de verdade)
 *   - resolveCustomerForPerson/linkPersonToCustomerIfConfident (Fase 1 — Customer Identity)
 *   - external_entity_links (Fase 2 — Integration Foundation)
 *
 * Hierarquia de decisão (seções 13-22 do pedido da Fase 3):
 *   1. Já existe external_entity_links pra este chatwoot_contact_id? Usa
 *      essa pessoa como referência ESTÁVEL — nunca recria por causa de
 *      telefone/e-mail terem mudado (seção 20).
 *   2. Contato novo: telefone E e-mail apontando pra crm_persons DIFERENTES
 *      já existentes → CONFLICT, nunca merge automático (seção 16).
 *   3. Contato novo, nenhum conflito: cria (ou reaproveita) UMA pessoa só,
 *      anexando telefone E e-mail à MESMA pessoa quando ambos disponíveis.
 *   4. Nome do Chatwoot só preenche display_name quando está "ausente"
 *      (placeholder auto-gerado) — nunca usado pra matching (seção 17).
 */

import { normalizeE164BR } from '@/lib/utils/phone'
import {
  createChannelIdentity,
  findOrCreateChannelIdentity,
  findPersonByIdentity,
  normalizeChannelIdentityValue,
} from '@/services/crm/channel-identities.service'
import { updatePersonDisplayNameIfBlank } from '@/services/crm/persons.service'
import { linkPersonToCustomerIfConfident, normalizeEmailForMatching, type CustomerMatchTier } from '@/services/crm/customer-identity.service'
import { findExternalEntity, linkExternalEntity } from '@/services/integrations/external-entity-links.service'
import type { ServiceOutcome } from '@/services/produtos.service'
import type { EmbeddedContact } from './types'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type ContactResolutionStatus = 'linked_existing' | 'created' | 'conflict' | 'no_identity'

export interface ContactResolutionResult {
  status: ContactResolutionStatus
  personId?: number
  customerLinkTier?: CustomerMatchTier
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

type IdentityAttachOutcome = { ok: true } | { ok: false; conflictPersonId: number | null }

/**
 * Anexa uma identidade de canal a `personId` se ainda não estiver anexada.
 * Se já pertencer a OUTRA pessoa, é conflito — nunca rouba/realoca (nunca
 * faz merge silencioso, seção 16).
 */
async function attachIdentityIfNew(
  companyId: number,
  personId: number,
  channelType: 'whatsapp' | 'email',
  normalizedValue: string,
): Promise<IdentityAttachOutcome> {
  const existing = await findPersonByIdentity(companyId, channelType, normalizedValue)
  if (existing.ok && existing.data) {
    if (existing.data.person_id === personId) return { ok: true }
    return { ok: false, conflictPersonId: existing.data.person_id }
  }

  const created = await createChannelIdentity({
    companyId,
    personId,
    channelType,
    value: normalizedValue,
    createdSource: 'other',
  })
  if (created.ok) return { ok: true }

  // 409 = corrida (alguém criou entre o lookup e agora) — refaz o lookup
  // pra decidir se é a mesma pessoa (ok) ou conflito de verdade.
  const recheck = await findPersonByIdentity(companyId, channelType, normalizedValue)
  if (recheck.ok && recheck.data) {
    return recheck.data.person_id === personId ? { ok: true } : { ok: false, conflictPersonId: recheck.data.person_id }
  }
  return { ok: false, conflictPersonId: null }
}

// ─── Operação principal ─────────────────────────────────────────────────────

export async function resolveContactFromChatwoot(
  companyId: number,
  integrationId: number,
  contact: EmbeddedContact,
): Promise<ServiceOutcome<ContactResolutionResult>> {
  const phoneE164 = contact.phone_number ? normalizeE164BR(normalizeChannelIdentityValue('whatsapp', contact.phone_number)) || null : null
  const email = normalizeEmailForMatching(contact.email)
  const displayName = (contact.name && contact.name.trim()) || `Contato Chatwoot #${contact.id}`

  // ── 1. Vínculo externo já existe? Referência estável, nunca recria. ──────
  const existingLink = await findExternalEntity(integrationId, 'contact', contact.id)
  if (!existingLink.ok) return failure(existingLink.error, existingLink.status)

  if (existingLink.data) {
    const personId = Number(existingLink.data.entity_id)
    await updatePersonDisplayNameIfBlank(personId, companyId, displayName)

    if (phoneE164) {
      const r = await attachIdentityIfNew(companyId, personId, 'whatsapp', phoneE164)
      if (!r.ok) return success({ status: 'conflict', personId })
    }
    if (email) {
      const r = await attachIdentityIfNew(companyId, personId, 'email', email)
      if (!r.ok) return success({ status: 'conflict', personId })
    }

    const linked = await linkPersonToCustomerIfConfident(personId, companyId)
    return success({ status: 'linked_existing', personId, customerLinkTier: linked.ok ? linked.data.tier : undefined })
  }

  if (!phoneE164 && !email) {
    return success({ status: 'no_identity' })
  }

  // ── 2. Contato novo — telefone e e-mail já apontam pra pessoas diferentes? ──
  const byPhone = phoneE164 ? await findPersonByIdentity(companyId, 'whatsapp', phoneE164) : null
  const byEmail = email ? await findPersonByIdentity(companyId, 'email', email) : null

  if (byPhone?.ok && byPhone.data && byEmail?.ok && byEmail.data && byPhone.data.person_id !== byEmail.data.person_id) {
    return success({ status: 'conflict' })
  }

  let personId = byPhone?.data?.person_id ?? byEmail?.data?.person_id ?? null

  if (personId) {
    // Uma das duas identidades já existia (aponta pra uma pessoa real) — reaproveita.
    await updatePersonDisplayNameIfBlank(personId, companyId, displayName)
    if (phoneE164 && !byPhone?.data) {
      const r = await attachIdentityIfNew(companyId, personId, 'whatsapp', phoneE164)
      if (!r.ok) return success({ status: 'conflict', personId: personId! })
    }
    if (email && !byEmail?.data) {
      const r = await attachIdentityIfNew(companyId, personId, 'email', email)
      if (!r.ok) return success({ status: 'conflict', personId: personId! })
    }
  } else {
    // Pessoa genuinamente nova — cria via RPC segura (advisory lock),
    // usando a primeira identidade disponível (telefone com prioridade).
    const primaryChannelType = phoneE164 ? 'whatsapp' : 'email'
    const primaryValue = phoneE164 ?? email!

    const createdResult = await findOrCreateChannelIdentity({
      companyId,
      channelType: primaryChannelType,
      value: primaryValue,
      displayNameHint: displayName,
      personCreatedSource: 'other',
      identityCreatedSource: 'other',
    })
    if (!createdResult.ok) return failure(createdResult.error, createdResult.status)
    personId = createdResult.data.personId

    if (phoneE164 && email) {
      const r = await attachIdentityIfNew(companyId, personId, 'email', email)
      if (!r.ok) return success({ status: 'conflict', personId: personId! })
    }
  }

  const linkExternal = await linkExternalEntity({
    companyId,
    integrationId,
    provider: 'chatwoot',
    entityType: 'crm_person',
    entityId: personId!,
    externalEntityType: 'contact',
    externalId: contact.id,
  })
  if (!linkExternal.ok && linkExternal.status !== 409) {
    return failure(linkExternal.error, linkExternal.status)
  }

  const linked = await linkPersonToCustomerIfConfident(personId!, companyId)
  return success({ status: 'created', personId: personId!, customerLinkTier: linked.ok ? linked.data.tier : undefined })
}
