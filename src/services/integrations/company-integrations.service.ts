/**
 * Service de Integrações — Company Integrations (Fase 2).
 *
 * Fonte canônica de "empresa X está conectada ao provider Y, com esta
 * configuração não sensível". NUNCA retorna segredo — isso é
 * `secrets.service.ts`, chamada separada, explicitamente server-side (seção
 * 14 do pedido da Fase 2: reduzir vazamento acidental).
 *
 * Toda leitura/escrita normal é escopada por `company_id`, exceto
 * `findIntegrationByExternalAccount` — a ÚNICA função deste service que
 * busca sem `company_id` de entrada, porque é exatamente o inverso: resolver
 * qual empresa é dona de um `external_account_id` que chegou de fora (ex.:
 * webhook do Chatwoot informando o account_id dele). Isso só é seguro porque
 * `uq_company_integrations_provider_account` (índice único global por
 * provider) garante que existe no máximo 1 dono — nunca ambíguo.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { ServiceOutcome } from '../produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

// 'fiscal_certificate' — Motor Fiscal Configurável Fase 2: NÃO é uma
// integração externa de verdade (não há "conta" em outro sistema) — é
// reaproveitamento deliberado desta infra (linha por empresa + segredos
// criptografados em integration_secrets) como o "cofre" de certificado
// digital (.pfx) + senha + CSC Token da empresa. Ver
// certificateService.ts. Amplia o MESMO CHECK constraint já usado por
// 'focus_nfe' (migration 202609051100).
export type IntegrationProvider = 'chatwoot' | 'meta' | 'nuvemshop' | 'focus_nfe' | 'fiscal_certificate'
export type IntegrationStatus = 'pending' | 'active' | 'inactive' | 'error'

export interface CompanyIntegration {
  id: number
  company_id: number
  provider: IntegrationProvider
  external_account_id: string | null
  status: IntegrationStatus
  settings: Record<string, unknown>
  last_error: string | null
  created_at: string
  updated_at: string
  created_by: string | null
}

export interface CreateCompanyIntegrationInput {
  companyId: number
  provider: IntegrationProvider
  externalAccountId?: string | null
  settings?: Record<string, unknown>
  createdBy?: string | null
}

export interface UpdateCompanyIntegrationInput {
  externalAccountId?: string | null
  status?: IntegrationStatus
  settings?: Record<string, unknown>
  lastError?: string | null
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
    return { message: 'Já existe uma integração deste provider com esta conta externa (em outra empresa, ou duplicada).', status: 409 }
  }
  return { message: error.message, status: 500 }
}

// ─── Operações ─────────────────────────────────────────────────────────────────

export async function createCompanyIntegration(
  input: CreateCompanyIntegrationInput,
): Promise<ServiceOutcome<CompanyIntegration>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('company_integrations')
    .insert({
      company_id: input.companyId,
      provider: input.provider,
      external_account_id: input.externalAccountId ?? null,
      settings: input.settings ?? {},
      created_by: input.createdBy ?? null,
    })
    .select('*')
    .single() as { data: CompanyIntegration | null; error: { code?: string; message: string } | null }

  if (error) {
    const { message, status } = uniqueViolation(error)
    return failure(message, status)
  }
  return success(data!)
}

/** Busca escopada por empresa — o caminho normal de toda a aplicação. */
export async function getCompanyIntegration(
  companyId: number,
  provider: IntegrationProvider,
): Promise<ServiceOutcome<CompanyIntegration | null>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('company_integrations')
    .select('*')
    .eq('company_id', companyId)
    .eq('provider', provider)
    .maybeSingle() as { data: CompanyIntegration | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data)
}

export async function listCompanyIntegrations(companyId: number): Promise<ServiceOutcome<CompanyIntegration[]>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('company_integrations')
    .select('*')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false }) as { data: CompanyIntegration[] | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data ?? [])
}

export async function updateCompanyIntegration(
  integrationId: number,
  companyId: number,
  patch: UpdateCompanyIntegrationInput,
): Promise<ServiceOutcome<CompanyIntegration>> {
  const admin = createAdminClient()
  const payload: Record<string, unknown> = {}
  if ('externalAccountId' in patch) payload.external_account_id = patch.externalAccountId
  if (patch.status !== undefined) payload.status = patch.status
  if (patch.settings !== undefined) payload.settings = patch.settings
  if ('lastError' in patch) payload.last_error = patch.lastError

  const { data, error } = await (admin as any)
    .from('company_integrations')
    .update(payload)
    .eq('id', integrationId)
    .eq('company_id', companyId)
    .select('*')
    .maybeSingle() as { data: CompanyIntegration | null; error: { code?: string; message: string } | null }

  if (error) {
    const { message, status } = uniqueViolation(error)
    return failure(message, status)
  }
  if (!data) return failure('Integração não encontrada.', 404)
  return success(data)
}

/**
 * Resolução inversa: dado um provider + o id de conta que o provider usa
 * (ex.: account_id do Chatwoot vindo de um webhook), descobre a QUE empresa
 * essa integração pertence. Não recebe `company_id` — é literalmente o que
 * esta função existe pra descobrir. Segura porque
 * `uq_company_integrations_provider_account` garante unicidade global.
 * `company_id NUNCA vem confiado do payload do webhook` continua valendo —
 * é esta função, e só ela, que faz essa resolução, nunca o payload
 * diretamente.
 */
export async function findIntegrationByExternalAccount(
  provider: IntegrationProvider,
  externalAccountId: string,
): Promise<ServiceOutcome<CompanyIntegration | null>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('company_integrations')
    .select('*')
    .eq('provider', provider)
    .eq('external_account_id', externalAccountId)
    .eq('status', 'active')
    .maybeSingle() as { data: CompanyIntegration | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data)
}
