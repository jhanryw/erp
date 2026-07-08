/**
 * Service de CRM — Conversas (crm_conversations).
 *
 * Vincula um crm_channels (canal operacional da empresa) a um
 * crm_channel_identities (identidade de canal de uma pessoa) — os dois são
 * independentes desde a Entrega 1 (o mesmo número de uma pessoa pode ser
 * alcançado por mais de um WhatsApp da empresa), então nada no banco garante
 * que os dois tenham o mesmo channel_type. channelAndIdentityMatch() é essa
 * checagem, aqui na service layer, mesma categoria de
 * entityBelongsToCompany()/organizationAndPersonBelongToCompany().
 *
 * findOrCreateConversation() é a operação de "create" real: existe no máximo
 * uma conversa open/pending por (channel_id, channel_identity_id) — índice
 * único parcial no banco é a rede de segurança contra corrida, esta função
 * tenta achar antes de inserir e trata 23505 como "outra chamada venceu a
 * corrida" (relê e retorna a existente, não é erro).
 *
 * Entrega 2 (Fase 3): create (find-or-create)/get/list + updateStatus (sem
 * consumidor ainda — API/UI ficam para a Entrega 3).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { CrmConversation, CrmConversationStatus } from '@/types/database.types'
import type { ServiceOutcome } from '../produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface FindOrCreateConversationInput {
  companyId: number
  channelId: number
  channelIdentityId: number
  personId: number
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

// ─── Verificação de posse e coerência ─────────────────────────────────────────

/**
 * Confirma que channel_id e channel_identity_id pertencem à empresa e têm
 * o mesmo channel_type, e que channel_identity_id realmente pertence a
 * person_id. Nenhuma dessas checagens é impositível por FK simples entre
 * tabelas diferentes.
 */
export async function channelAndIdentityMatch(
  channelId: number,
  channelIdentityId: number,
  personId: number,
  companyId: number,
): Promise<boolean> {
  const admin = createAdminClient()

  const { data: channel } = await admin
    .from('crm_channels')
    .select('id, channel_type')
    .eq('id', channelId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: { id: number; channel_type: string } | null }

  const { data: identity } = await admin
    .from('crm_channel_identities')
    .select('id, channel_type, person_id')
    .eq('id', channelIdentityId)
    .eq('company_id', companyId)
    .eq('person_id', personId)
    .maybeSingle() as unknown as { data: { id: number; channel_type: string; person_id: number } | null }

  if (!channel || !identity) return false
  return channel.channel_type === identity.channel_type
}

// ─── Operações ─────────────────────────────────────────────────────────────────

/**
 * Encontra a conversa open/pending para (channel_id, channel_identity_id)
 * ou cria uma nova. Idempotente mesmo sob corrida — se o INSERT colidir com
 * o índice único parcial (outra chamada venceu), relê e retorna a existente.
 */
export async function findOrCreateConversation(
  input: FindOrCreateConversationInput,
): Promise<ServiceOutcome<CrmConversation>> {
  const matches = await channelAndIdentityMatch(input.channelId, input.channelIdentityId, input.personId, input.companyId)
  if (!matches) {
    return failure('Canal e identidade de canal não são compatíveis (empresa, pessoa ou channel_type divergem).', 422)
  }

  const admin = createAdminClient()

  const { data: existing } = await admin
    .from('crm_conversations')
    .select('*')
    .eq('channel_id', input.channelId)
    .eq('channel_identity_id', input.channelIdentityId)
    .in('status', ['open', 'pending'])
    .maybeSingle() as unknown as { data: CrmConversation | null }

  if (existing) return success(existing)

  const { data, error } = await admin
    .from('crm_conversations')
    .insert({
      company_id: input.companyId,
      channel_id: input.channelId,
      channel_identity_id: input.channelIdentityId,
      person_id: input.personId,
    } as any)
    .select('*')
    .single() as unknown as { data: CrmConversation | null; error: { code?: string; message: string } | null }

  if (error) {
    if (error.code === '23505') {
      const { data: retried } = await admin
        .from('crm_conversations')
        .select('*')
        .eq('channel_id', input.channelId)
        .eq('channel_identity_id', input.channelIdentityId)
        .in('status', ['open', 'pending'])
        .maybeSingle() as unknown as { data: CrmConversation | null }
      if (retried) return success(retried)
    }
    return failure(error.message)
  }

  return success(data!)
}

export async function getConversation(conversationId: number, companyId: number): Promise<ServiceOutcome<CrmConversation>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_conversations')
    .select('*')
    .eq('id', conversationId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: CrmConversation | null; error: { message: string } | null }

  if (error) return failure(error.message)
  if (!data) return failure('Conversa não encontrada.', 404)
  return success(data)
}

export async function listConversationsByPerson(
  personId: number,
  companyId: number,
  options?: { status?: CrmConversationStatus },
): Promise<ServiceOutcome<CrmConversation[]>> {
  const admin = createAdminClient()
  let query = (admin as any)
    .from('crm_conversations')
    .select('*')
    .eq('person_id', personId)
    .eq('company_id', companyId)
  if (options?.status) query = query.eq('status', options.status)

  const { data, error } = await query.order('last_message_at', { ascending: false, nullsFirst: false }) as {
    data: CrmConversation[] | null
    error: { message: string } | null
  }
  if (error) return failure(error.message)
  return success(data ?? [])
}

/**
 * Transição de status (ex.: encerrar/reabrir conversa). Sem consumidor
 * ainda — API/UI de inbox ficam para entrega futura.
 */
export async function updateConversationStatus(
  conversationId: number,
  companyId: number,
  status: CrmConversationStatus,
): Promise<ServiceOutcome<void>> {
  const admin = createAdminClient()
  const { error } = await (admin as any)
    .from('crm_conversations')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', conversationId)
    .eq('company_id', companyId) as { error: { message: string } | null }

  if (error) return failure(error.message)
  return success(undefined)
}
