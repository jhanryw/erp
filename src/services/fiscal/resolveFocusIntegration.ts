/**
 * Resolução da integração Focus NFe de uma empresa (Fase Fiscal 1).
 *
 * Único ponto do projeto que junta `company_integrations` (provider
 * 'focus_nfe') + `integration_secrets` (key 'api_token') pra devolver
 * {token, environment} prontos pro cliente HTTP — mesmo padrão de resolução
 * já usado pelas integrações Chatwoot/Meta, reaproveitando
 * `getCompanyIntegration`/`getIntegrationSecret` em vez de duplicar query.
 *
 * O token NUNCA aparece em log/erro deste módulo — falhas retornam só uma
 * `reason` textual (ex.: "token_missing"), nunca o valor decifrado.
 */

import { getCompanyIntegration } from '@/services/integrations/company-integrations.service'
import { getIntegrationSecret } from '@/services/integrations/secrets.service'
import type { FocusEnvironment } from '@/lib/integrations/focus/types'
import type { ServiceOutcome } from '@/services/produtos.service'

const FOCUS_TOKEN_KEY = 'api_token'

export type FocusIntegrationUnavailableReason =
  | 'integration_not_found'
  | 'integration_disabled'
  | 'token_missing'

export interface ResolvedFocusIntegration {
  integrationId: number
  companyId: number
  token: string
  environment: FocusEnvironment
}

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

/**
 * Retorna a integração pronta pra uso, ou `{ available: false, reason }`
 * quando não configurada/desabilitada/sem segredo — nunca lança pra esses
 * casos esperados (só erro de infraestrutura vira `ServiceOutcome` de erro).
 */
export async function resolveFocusIntegration(
  companyId: number,
): Promise<ServiceOutcome<{ available: true; integration: ResolvedFocusIntegration } | { available: false; reason: FocusIntegrationUnavailableReason }>> {
  const integrationResult = await getCompanyIntegration(companyId, 'focus_nfe')
  if (!integrationResult.ok) return failure(integrationResult.error, integrationResult.status)

  const integration = integrationResult.data
  if (!integration) return success({ available: false, reason: 'integration_not_found' })
  if (integration.status !== 'active') return success({ available: false, reason: 'integration_disabled' })

  const secretResult = await getIntegrationSecret(integration.id, companyId, FOCUS_TOKEN_KEY)
  if (!secretResult.ok) return failure(secretResult.error, secretResult.status)
  if (!secretResult.data) return success({ available: false, reason: 'token_missing' })

  const environment = (integration.settings?.environment === 'producao' ? 'producao' : 'homologacao') as FocusEnvironment

  return success({
    available: true,
    integration: {
      integrationId: integration.id,
      companyId,
      token: secretResult.data,
      environment,
    },
  })
}
