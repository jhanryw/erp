/**
 * Service de Integrações — External Entity Links (Fase 2).
 *
 * Referência entre uma entidade interna do Qarvon (crm_person,
 * crm_conversation, customer) e uma entidade em sistema externo (Chatwoot
 * contact, Chatwoot conversation, Nuvemshop customer...). Distinto de
 * identidade humana (crm_channel_identities) por desenho — decisão já
 * fechada antes desta fase.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { ServiceOutcome } from '../produtos.service'
import type { IntegrationProvider } from './company-integrations.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type ExternalLinkEntityType = 'crm_person' | 'crm_conversation' | 'customer'

export interface ExternalEntityLink {
  id: number
  company_id: number
  integration_id: number
  provider: IntegrationProvider
  entity_type: ExternalLinkEntityType
  entity_id: string
  external_entity_type: string
  external_id: string
  metadata: Record<string, unknown>
  active: boolean
  created_at: string
  updated_at: string
}

export interface LinkExternalEntityInput {
  companyId: number
  integrationId: number
  provider: IntegrationProvider
  entityType: ExternalLinkEntityType
  entityId: string | number
  externalEntityType: string
  externalId: string
  metadata?: Record<string, unknown>
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
    return { message: 'Já existe um vínculo ativo (mesma entidade externa já ligada a outra entidade interna, ou vínculo já existe).', status: 409 }
  }
  return { message: error.message, status: 500 }
}

// ─── Operações ─────────────────────────────────────────────────────────────────

/** Idempotente: recriar o mesmo vínculo (mesma integração+entidade interna+tipo externo) não duplica, retorna 409 tratável pelo chamador como "já existe". */
export async function linkExternalEntity(
  input: LinkExternalEntityInput,
): Promise<ServiceOutcome<ExternalEntityLink>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('external_entity_links')
    .insert({
      company_id: input.companyId,
      integration_id: input.integrationId,
      provider: input.provider,
      entity_type: input.entityType,
      entity_id: String(input.entityId),
      external_entity_type: input.externalEntityType,
      external_id: input.externalId,
      metadata: input.metadata ?? {},
    })
    .select('*')
    .single() as { data: ExternalEntityLink | null; error: { code?: string; message: string } | null }

  if (error) {
    const { message, status } = uniqueViolation(error)
    return failure(message, status)
  }
  return success(data!)
}

export async function unlinkExternalEntity(
  linkId: number,
  companyId: number,
): Promise<ServiceOutcome<void>> {
  const admin = createAdminClient()
  const { error, count } = await (admin as any)
    .from('external_entity_links')
    .update({ active: false })
    .eq('id', linkId)
    .eq('company_id', companyId)
    .eq('active', true)
    .select('id', { count: 'exact', head: true }) as { error: { message: string } | null; count: number | null }

  if (error) return failure(error.message)
  if (!count) return failure('Vínculo ativo não encontrado.', 404)
  return success(undefined)
}

/** Resolve a partir do lado EXTERNO (ex.: webhook do Chatwoot trazendo um contact_id) — escopado por integration_id, nunca por company_id de payload externo. */
export async function findExternalEntity(
  integrationId: number,
  externalEntityType: string,
  externalId: string,
): Promise<ServiceOutcome<ExternalEntityLink | null>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('external_entity_links')
    .select('*')
    .eq('integration_id', integrationId)
    .eq('external_entity_type', externalEntityType)
    .eq('external_id', externalId)
    .eq('active', true)
    .maybeSingle() as { data: ExternalEntityLink | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data)
}

/**
 * Mescla `patch` dentro de `metadata` (nunca substitui o objeto inteiro) —
 * usado pela Fase 4 pra registrar `last_synced_at`/`last_sync_error` sem
 * precisar de tabela nova (seção 37 do pedido: "evite nova tabela se
 * metadata resolver bem").
 */
export async function updateExternalEntityLinkMetadata(
  linkId: number,
  companyId: number,
  patch: Record<string, unknown>,
): Promise<ServiceOutcome<void>> {
  const admin = createAdminClient()
  const { data: current, error: readError } = await (admin as any)
    .from('external_entity_links')
    .select('metadata')
    .eq('id', linkId)
    .eq('company_id', companyId)
    .maybeSingle() as { data: { metadata: Record<string, unknown> } | null; error: { message: string } | null }

  if (readError) return failure(readError.message)
  if (!current) return failure('Vínculo não encontrado.', 404)

  const { error } = await (admin as any)
    .from('external_entity_links')
    .update({ metadata: { ...current.metadata, ...patch } })
    .eq('id', linkId)
    .eq('company_id', companyId)

  if (error) return failure(error.message)
  return success(undefined)
}

/** Resolve a partir do lado INTERNO (ex.: "esta crm_person já tem um Chatwoot contact vinculado?"). */
export async function findLinkForEntity(
  integrationId: number,
  entityType: ExternalLinkEntityType,
  entityId: string | number,
  externalEntityType: string,
): Promise<ServiceOutcome<ExternalEntityLink | null>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('external_entity_links')
    .select('*')
    .eq('integration_id', integrationId)
    .eq('entity_type', entityType)
    .eq('entity_id', String(entityId))
    .eq('external_entity_type', externalEntityType)
    .eq('active', true)
    .maybeSingle() as { data: ExternalEntityLink | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data)
}
