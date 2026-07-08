/**
 * Service de CRM — Consentimento (crm_consent_events).
 *
 * Ledger imutável — este arquivo NUNCA deve ganhar uma função de update ou
 * delete. Estado atual é sempre lido via v_crm_consent_status (view), nunca
 * por UPDATE na tabela de eventos. Imutabilidade também é reforçada por
 * trigger no banco (crm_consent_events_block_mutation) — este service é a
 * segunda camada, não a única.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type {
  CrmConsentEvent,
  CrmConsentStatus,
  CrmConsentPurpose,
  CrmConsentEventType,
  CrmConsentSource,
  CrmChannelType,
} from '@/types/database.types'
import type { ServiceOutcome } from '../produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface RecordConsentEventInput {
  companyId: number
  personId: number
  purpose: CrmConsentPurpose
  channelType?: CrmChannelType | null
  eventType: CrmConsentEventType
  source: CrmConsentSource
  evidence?: Record<string, unknown> | null
  createdBy?: string | null
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

// ─── Operações ─────────────────────────────────────────────────────────────────

/**
 * Registra um evento de consentimento (grant ou revoke). Nunca atualiza um
 * evento existente — uma revogação é um novo evento com event_type='revoked',
 * não uma alteração do evento de concessão anterior.
 */
export async function createConsentEvent(input: RecordConsentEventInput): Promise<ServiceOutcome<CrmConsentEvent>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_consent_events')
    .insert({
      company_id: input.companyId,
      person_id: input.personId,
      purpose: input.purpose,
      channel_type: input.channelType ?? null,
      event_type: input.eventType,
      source: input.source,
      evidence: input.evidence ?? null,
      created_by: input.createdBy ?? null,
    } as any)
    .select('*')
    .single() as unknown as { data: CrmConsentEvent | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data!)
}

/**
 * Histórico completo de eventos de uma pessoa — inclui grants e revokes,
 * em ordem cronológica decrescente.
 */
export async function listConsentEvents(
  personId: number,
  companyId: number,
  options?: { purpose?: CrmConsentPurpose; channelType?: CrmChannelType | null },
): Promise<ServiceOutcome<CrmConsentEvent[]>> {
  const admin = createAdminClient()
  let query = (admin as any)
    .from('crm_consent_events')
    .select('*')
    .eq('person_id', personId)
    .eq('company_id', companyId)
  if (options?.purpose) query = query.eq('purpose', options.purpose)
  if (options?.channelType !== undefined) query = query.eq('channel_type', options.channelType)

  const { data, error } = await query.order('occurred_at', { ascending: false }) as {
    data: CrmConsentEvent[] | null
    error: { message: string } | null
  }
  if (error) return failure(error.message)
  return success(data ?? [])
}

/**
 * Estado atual de consentimento de uma pessoa — sempre via v_crm_consent_status
 * (último evento por pessoa/finalidade/canal), nunca por leitura direta da
 * tabela de eventos interpretada "na mão".
 */
export async function getCurrentConsentStatus(
  personId: number,
  companyId: number,
  options?: { purpose?: CrmConsentPurpose; channelType?: CrmChannelType | null },
): Promise<ServiceOutcome<CrmConsentStatus[]>> {
  const admin = createAdminClient()
  let query = (admin as any)
    .from('v_crm_consent_status')
    .select('*')
    .eq('person_id', personId)
    .eq('company_id', companyId)
  if (options?.purpose) query = query.eq('purpose', options.purpose)
  if (options?.channelType !== undefined) query = query.eq('channel_type', options.channelType)

  const { data, error } = await query as { data: CrmConsentStatus[] | null; error: { message: string } | null }
  if (error) return failure(error.message)
  return success(data ?? [])
}
