/**
 * Resolução do TOKEN MESTRE da conta Focus (Motor Fiscal Configurável —
 * Certificado/CSC). Arquivo IRMÃO de `resolveFocusIntegration.ts`,
 * deliberadamente SEPARADO — os dois nunca compartilham código nem
 * secret:
 *
 *   resolveFocusIntegration        → 'emission_token_homologacao' /
 *                                     'emission_token_producao' (ou
 *                                     'api_token' legado só em
 *                                     homologação) — usado por TODA a
 *                                     emissão de documento fiscal.
 *   resolveFocusManagementToken    → 'master_token' — usado
 *                                     EXCLUSIVAMENTE por
 *                                     `focusEmpresa.service.ts` pra
 *                                     `/v2/empresas` (cadastro/
 *                                     certificado/CSC). NUNCA entra no
 *                                     pipeline de emissão.
 *
 * O host de gerenciamento é SEMPRE produção (`api.focusnfe.com.br`) —
 * confirmado na doc oficial ("esta API opera exclusivamente no ambiente
 * de produção") — independente de `company_integrations.settings.
 * environment` (que só rege o ambiente de EMISSÃO). Por isso esta função
 * nem lê `environment` — não existe "master_token de homologação".
 */

import { getCompanyIntegration } from '@/services/integrations/company-integrations.service'
import { getIntegrationSecret } from '@/services/integrations/secrets.service'
import type { ServiceOutcome } from '@/services/produtos.service'

const MASTER_TOKEN_KEY = 'master_token'

export type FocusManagementUnavailableReason =
  | 'integration_not_found'
  | 'integration_disabled'
  | 'master_token_missing'

export interface ResolvedFocusManagementToken {
  integrationId: number
  companyId: number
  token: string
}

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

export async function resolveFocusManagementToken(
  companyId: number,
): Promise<ServiceOutcome<{ available: true; integration: ResolvedFocusManagementToken } | { available: false; reason: FocusManagementUnavailableReason }>> {
  const integrationResult = await getCompanyIntegration(companyId, 'focus_nfe')
  if (!integrationResult.ok) return failure(integrationResult.error, integrationResult.status)

  const integration = integrationResult.data
  if (!integration) return success({ available: false, reason: 'integration_not_found' })
  if (integration.status !== 'active') return success({ available: false, reason: 'integration_disabled' })

  const tokenResult = await getIntegrationSecret(integration.id, companyId, MASTER_TOKEN_KEY)
  if (!tokenResult.ok) return failure(tokenResult.error, tokenResult.status)
  if (!tokenResult.data) return success({ available: false, reason: 'master_token_missing' })

  return success({
    available: true,
    integration: {
      integrationId: integration.id,
      companyId,
      token: tokenResult.data,
    },
  })
}
