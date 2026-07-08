/**
 * Service de CRM — Identidades de Canal (crm_channel_identities).
 *
 * Identidade de canal de uma PESSOA (telefone WhatsApp, @ Instagram,
 * e-mail, buyer id de marketplace) — distinta de crm_channels (canal que a
 * empresa opera). Não tem FK para um crm_channels específico: o mesmo
 * telefone de uma pessoa pode ser alcançado por qualquer WhatsApp da
 * empresa, não só um.
 *
 * `findPersonByIdentity` existe desde já porque é o lookup que qualquer
 * fluxo futuro de mensagem inbound (N8N→ERP) vai precisar para resolver
 * "de quem é este número" — nenhum consumidor chama isso ainda.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeE164BR } from '@/lib/utils/phone'
import type {
  CrmChannelIdentity,
  CrmChannelType,
  CrmChannelIdentityCreatedSource,
  CrmPersonCreatedSource,
} from '@/types/database.types'
import type { ServiceOutcome } from '../produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface CreateCrmChannelIdentityInput {
  companyId: number
  personId: number
  channelType: CrmChannelType
  value: string
  verified?: boolean
  createdSource: CrmChannelIdentityCreatedSource
}

export interface FindOrCreateChannelIdentityInput {
  companyId: number
  channelType: CrmChannelType
  value: string
  displayNameHint?: string | null
  personCreatedSource: CrmPersonCreatedSource
  identityCreatedSource: CrmChannelIdentityCreatedSource
}

export interface FindOrCreateChannelIdentityResult {
  personId: number
  channelIdentityId: number
  personCreated: boolean
  identityCreated: boolean
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
    return { message: 'Este valor já está vinculado a outra pessoa neste canal.', status: 409 }
  }
  return { message: error.message, status: 500 }
}

// ─── Operações ─────────────────────────────────────────────────────────────────

export async function createChannelIdentity(
  input: CreateCrmChannelIdentityInput,
): Promise<ServiceOutcome<CrmChannelIdentity>> {
  const value = input.value.trim()
  if (!value) return failure('Valor da identidade de canal é obrigatório.', 422)

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_channel_identities')
    .insert({
      company_id: input.companyId,
      person_id: input.personId,
      channel_type: input.channelType,
      value,
      verified: input.verified ?? false,
      created_source: input.createdSource,
    } as any)
    .select('*')
    .single() as unknown as { data: CrmChannelIdentity | null; error: { code?: string; message: string } | null }

  if (error) {
    const { message, status } = uniqueViolation(error)
    return failure(message, status)
  }
  return success(data!)
}

export async function getChannelIdentity(
  channelIdentityId: number,
  companyId: number,
): Promise<ServiceOutcome<CrmChannelIdentity>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_channel_identities')
    .select('*')
    .eq('id', channelIdentityId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: CrmChannelIdentity | null; error: { message: string } | null }

  if (error) return failure(error.message)
  if (!data) return failure('Identidade de canal não encontrada.', 404)
  return success(data)
}

export async function listChannelIdentitiesByPerson(
  personId: number,
  companyId: number,
  options?: { includeInactive?: boolean },
): Promise<ServiceOutcome<CrmChannelIdentity[]>> {
  const admin = createAdminClient()
  let query = (admin as any)
    .from('crm_channel_identities')
    .select('*')
    .eq('person_id', personId)
    .eq('company_id', companyId)
  if (!options?.includeInactive) query = query.eq('active', true)

  const { data, error } = await query.order('created_at', { ascending: false }) as {
    data: CrmChannelIdentity[] | null
    error: { message: string } | null
  }
  if (error) return failure(error.message)
  return success(data ?? [])
}

/**
 * Resolve qual pessoa é dona de um valor de identidade num canal — lookup
 * de base para o futuro fluxo de mensagem inbound. Só considera vínculos
 * ativos (mesma disciplina do índice único parcial).
 */
export async function findPersonByIdentity(
  companyId: number,
  channelType: CrmChannelType,
  value: string,
): Promise<ServiceOutcome<CrmChannelIdentity | null>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_channel_identities')
    .select('*')
    .eq('company_id', companyId)
    .eq('channel_type', channelType)
    .eq('value', value.trim())
    .eq('active', true)
    .maybeSingle() as unknown as { data: CrmChannelIdentity | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data)
}

/**
 * Normaliza o valor bruto de uma identidade de canal segundo o channel_type,
 * ANTES de qualquer lookup/insert. Sem isso, o mesmo número/handle chegando
 * em formatos diferentes (com/sem DDI, @, maiúscula) criaria pessoas
 * duplicadas. Usada pela ingestão inbound (Entrega 3) — createChannelIdentity
 * continua "burra" (confia no chamador já ter normalizado), não muda de
 * contrato.
 */
export function normalizeChannelIdentityValue(channelType: CrmChannelType, rawValue: string): string {
  const trimmed = rawValue.trim()
  switch (channelType) {
    case 'whatsapp':
    case 'telegram':
      return normalizeE164BR(trimmed)
    case 'instagram':
    case 'messenger':
      return trimmed.replace(/^@/, '').toLowerCase()
    case 'email':
      return trimmed.toLowerCase()
    case 'mercado_livre':
    case 'shopee':
    case 'site_chat':
    case 'other':
    default:
      return trimmed
  }
}

/**
 * Resolve ou cria pessoa+identidade de canal atomicamente via RPC
 * (pg_advisory_xact_lock escopado a company_id/channel_type/value) — evita
 * pessoa órfã sob concorrência real (duas mensagens quase simultâneas do
 * mesmo número novo). Não normaliza `value` — chamador (ingestão inbound)
 * já deve ter passado por normalizeChannelIdentityValue().
 */
export async function findOrCreateChannelIdentity(
  input: FindOrCreateChannelIdentityInput,
): Promise<ServiceOutcome<FindOrCreateChannelIdentityResult>> {
  if (!input.value) return failure('Valor da identidade de canal é obrigatório.', 422)

  const admin = createAdminClient()
  const { data, error } = await (admin as any).rpc('rpc_find_or_create_crm_person_by_identity', {
    p_company_id: input.companyId,
    p_channel_type: input.channelType,
    p_value: input.value,
    p_display_name: input.displayNameHint ?? null,
    p_person_created_source: input.personCreatedSource,
    p_identity_created_source: input.identityCreatedSource,
  }) as unknown as {
    data: { person_id: number; channel_identity_id: number; person_created: boolean; identity_created: boolean } | null
    error: { message: string } | null
  }

  if (error) return failure(error.message)
  if (!data) return failure('Falha ao resolver pessoa/identidade de canal.')

  return success({
    personId: data.person_id,
    channelIdentityId: data.channel_identity_id,
    personCreated: data.person_created,
    identityCreated: data.identity_created,
  })
}
