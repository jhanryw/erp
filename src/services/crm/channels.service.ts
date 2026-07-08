/**
 * Service de CRM — Canais operacionais (crm_channels).
 *
 * Canal que a EMPRESA opera (uma instância WhatsApp, uma caixa de e-mail) —
 * distinto de crm_channel_identities (identidade de canal de uma PESSOA).
 * É o campo `provider_instance_identifier` que resolve o hoje hardcoded
 * "santtorini" no fluxo N8N: mapeamento empresa→instância passa a existir
 * no banco em vez de constante fixa no workflow.
 *
 * `external_config` NUNCA guarda credencial/token/senha — só configuração
 * operacional não sensível. Segredo continua em variável de ambiente/cofre
 * do N8N. Este service não valida o conteúdo de `external_config` (schema
 * livre por decisão), mas nenhuma função aqui aceita nem repassa segredo.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { CrmChannel, CrmChannelType, CrmChannelProvider, CrmChannelStatus, Json } from '@/types/database.types'
import type { ServiceOutcome } from '../produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface CreateCrmChannelInput {
  companyId: number
  name: string
  channelType: CrmChannelType
  provider: CrmChannelProvider
  providerInstanceIdentifier?: string | null
  externalConfig?: Json
  status?: CrmChannelStatus
  createdBy?: string | null
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
    return { message: 'Já existe um canal com este nome nesta empresa.', status: 409 }
  }
  return { message: error.message, status: 500 }
}

// ─── Operações ─────────────────────────────────────────────────────────────────

export async function createChannel(input: CreateCrmChannelInput): Promise<ServiceOutcome<CrmChannel>> {
  const name = input.name.trim()
  if (!name) return failure('Nome do canal é obrigatório.', 422)

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_channels')
    .insert({
      company_id: input.companyId,
      name,
      channel_type: input.channelType,
      provider: input.provider,
      provider_instance_identifier: input.providerInstanceIdentifier ?? null,
      external_config: input.externalConfig ?? {},
      status: input.status ?? 'active',
      created_by: input.createdBy ?? null,
    } as any)
    .select('*')
    .single() as unknown as { data: CrmChannel | null; error: { code?: string; message: string } | null }

  if (error) {
    const { message, status } = uniqueViolation(error)
    return failure(message, status)
  }
  return success(data!)
}

export async function getChannel(channelId: number, companyId: number): Promise<ServiceOutcome<CrmChannel>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_channels')
    .select('*')
    .eq('id', channelId)
    .eq('company_id', companyId)
    .maybeSingle() as unknown as { data: CrmChannel | null; error: { message: string } | null }

  if (error) return failure(error.message)
  if (!data) return failure('Canal não encontrado.', 404)
  return success(data)
}

export async function listChannels(
  companyId: number,
  options?: { includeInactive?: boolean; channelType?: CrmChannelType },
): Promise<ServiceOutcome<CrmChannel[]>> {
  const admin = createAdminClient()
  let query = (admin as any).from('crm_channels').select('*').eq('company_id', companyId)
  if (!options?.includeInactive) query = query.eq('active', true)
  if (options?.channelType) query = query.eq('channel_type', options.channelType)

  const { data, error } = await query.order('created_at', { ascending: false }) as {
    data: CrmChannel[] | null
    error: { message: string } | null
  }
  if (error) return failure(error.message)
  return success(data ?? [])
}

/**
 * Resolve um canal por `provider_instance_identifier` — sem `company_id`
 * no filtro, porque é justamente isso que este lookup ainda não sabe
 * (usado pela ingestão inbound, Entrega 3, antes de saber a empresa). Só
 * é seguro porque o campo tem índice único parcial em todo o banco (não
 * só por empresa) — ver 20260710_crm_inbound_ingestion_base.sql.
 *
 * Deliberadamente NÃO filtra por `active`/`status` aqui — devolve o canal
 * como está para o chamador decidir a mensagem de erro certa ("canal não
 * encontrado" vs. "canal encontrado mas inativo"), decisão de política que
 * pertence à rota, não a este lookup.
 */
export async function findChannelByProviderInstance(
  providerInstanceIdentifier: string,
): Promise<ServiceOutcome<CrmChannel | null>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_channels')
    .select('*')
    .eq('provider_instance_identifier', providerInstanceIdentifier)
    .maybeSingle() as unknown as { data: CrmChannel | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data)
}
