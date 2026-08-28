/**
 * Gerenciamento dos 3 tokens da Focus NFe (Motor Fiscal Configurável —
 * Certificado/CSC): `emission_token_homologacao`, `emission_token_producao`,
 * `master_token`. Todos vivem na MESMA linha `company_integrations`
 * (provider='focus_nfe') já usada por `resolveFocusIntegration`/
 * `resolveFocusManagementToken` — nunca cria uma segunda linha nem toca em
 * `settings.environment` de uma integração já existente (só define um
 * default na criação de uma integração nova, que nunca é o caso da empresa
 * que já emite hoje).
 *
 * Nunca retorna o valor completo do token — só os últimos 4 caracteres
 * mascarados (mesmo padrão de `certificateService.getCscMasked`).
 */

import { getCompanyIntegration, createCompanyIntegration } from '@/services/integrations/company-integrations.service'
import { setIntegrationSecret, getIntegrationSecret } from '@/services/integrations/secrets.service'
import type { ServiceOutcome } from '@/services/produtos.service'

const PROVIDER = 'focus_nfe' as const

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

function mask(value: string | null): string | null {
  return value ? `${'•'.repeat(12)}${value.slice(-4)}` : null
}

async function getOrCreateFocusIntegration(companyId: number, userId: string): Promise<ServiceOutcome<number>> {
  const existing = await getCompanyIntegration(companyId, PROVIDER)
  if (!existing.ok) return failure(existing.error, existing.status)
  if (existing.data) return success(existing.data.id)

  const created = await createCompanyIntegration({ companyId, provider: PROVIDER, settings: { environment: 'homologacao' }, createdBy: userId })
  if (!created.ok) return failure(created.error, created.status)
  return success(created.data.id)
}

export interface FocusTokensMasked {
  emissionTokenHomologacaoMasked: string | null
  emissionTokenProducaoMasked: string | null
  masterTokenMasked: string | null
}

export async function getFocusTokensMasked(companyId: number): Promise<ServiceOutcome<FocusTokensMasked>> {
  const integration = await getCompanyIntegration(companyId, PROVIDER)
  if (!integration.ok) return failure(integration.error, integration.status)
  if (!integration.data) {
    return success({ emissionTokenHomologacaoMasked: null, emissionTokenProducaoMasked: null, masterTokenMasked: null })
  }

  const [homolog, producao, master] = await Promise.all([
    getIntegrationSecret(integration.data.id, companyId, 'emission_token_homologacao'),
    getIntegrationSecret(integration.data.id, companyId, 'emission_token_producao'),
    getIntegrationSecret(integration.data.id, companyId, 'master_token'),
  ])
  if (!homolog.ok) return failure(homolog.error, homolog.status)
  if (!producao.ok) return failure(producao.error, producao.status)
  if (!master.ok) return failure(master.error, master.status)

  return success({
    emissionTokenHomologacaoMasked: mask(homolog.data),
    emissionTokenProducaoMasked: mask(producao.data),
    masterTokenMasked: mask(master.data),
  })
}

/** `environment` decide só QUAL chave de emissão recebe o valor — nunca toca em `settings.environment` (que controla o ambiente ATIVO de emissão, um conceito diferente). */
export async function saveEmissionToken(params: { companyId: number; userId: string; environment: 'homologacao' | 'producao'; token: string }): Promise<ServiceOutcome<void>> {
  const vault = await getOrCreateFocusIntegration(params.companyId, params.userId)
  if (!vault.ok) return failure(vault.error, vault.status)

  const key = params.environment === 'producao' ? 'emission_token_producao' : 'emission_token_homologacao'
  const saved = await setIntegrationSecret(vault.data, params.companyId, key, params.token)
  if (!saved.ok) return failure(saved.error, saved.status)
  return success(undefined)
}

/** Exclusivo pra `/v2/empresas` (gerenciamento) — nunca usado pela emissão. */
export async function saveMasterToken(params: { companyId: number; userId: string; token: string }): Promise<ServiceOutcome<void>> {
  const vault = await getOrCreateFocusIntegration(params.companyId, params.userId)
  if (!vault.ok) return failure(vault.error, vault.status)

  const saved = await setIntegrationSecret(vault.data, params.companyId, 'master_token', params.token)
  if (!saved.ok) return failure(saved.error, saved.status)
  return success(undefined)
}
