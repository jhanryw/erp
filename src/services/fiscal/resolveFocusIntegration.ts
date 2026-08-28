/**
 * Resolução da integração Focus NFe de uma empresa (Fase Fiscal 1;
 * revisada no Motor Fiscal Configurável — Certificado/CSC, seção de
 * "3 tokens": `emission_token_homologacao` / `emission_token_producao` /
 * `master_token`).
 *
 * Único ponto do projeto que junta `company_integrations` (provider
 * 'focus_nfe') + `integration_secrets` pra devolver {token, environment}
 * prontos pro cliente HTTP — usado por TODO o pipeline de emissão
 * (`submitNfceHomologacao.ts`, `submitNfeHomologacao.ts`, `focusEmpresa
 * .service.ts` antes desta revisão, `health.service.ts`).
 *
 * ─── Resolução do token de EMISSÃO (esta função) — regra de segurança
 * aprovada explicitamente (nunca reutilizar credencial de ambiente
 * desconhecido em produção) ───────────────────────────────────────────
 *   environment='homologacao':
 *     tenta 'emission_token_homologacao'
 *     ausente → fallback TEMPORÁRIO pro secret legado 'api_token'
 *       (comprovadamente funcional em homologação hoje — nunca apagado,
 *       nunca migrado automaticamente; existe só até o admin recadastrar
 *       explicitamente com o nome novo)
 *   environment='producao':
 *     tenta 'emission_token_producao'
 *     ausente → ERRO EXPLÍCITO ('production_token_missing') — NUNCA cai
 *       pro 'api_token' legado. Motivo: 'api_token' não tem metadado que
 *       prove formalmente a qual ambiente pertence (é comprovadamente um
 *       token de homologação hoje, mas nada no schema garante isso pra
 *       sempre) — uma futura troca de `settings.environment` pra
 *       'producao' NUNCA deve reutilizar silenciosamente essa credencial
 *       de ambiente desconhecido/errado.
 *
 * O `master_token` (gerenciamento — `/v2/empresas`) é resolvido por
 * `resolveFocusManagementToken.ts`, um arquivo IRMÃO, nunca por esta
 * função — os dois nunca se misturam.
 *
 * O token NUNCA aparece em log/erro deste módulo — falhas retornam só uma
 * `reason` textual, nunca o valor decifrado.
 */

import { getCompanyIntegration } from '@/services/integrations/company-integrations.service'
import { getIntegrationSecret } from '@/services/integrations/secrets.service'
import type { FocusEnvironment } from '@/lib/integrations/focus/types'
import type { ServiceOutcome } from '@/services/produtos.service'

const LEGACY_TOKEN_KEY = 'api_token'
const EMISSION_TOKEN_KEYS: Record<FocusEnvironment, string> = {
  homologacao: 'emission_token_homologacao',
  producao: 'emission_token_producao',
}

export type FocusIntegrationUnavailableReason =
  | 'integration_not_found'
  | 'integration_disabled'
  | 'token_missing'
  /** environment='producao' sem 'emission_token_producao' configurado — nunca cai pro legado. */
  | 'production_token_missing'

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

  const environment = (integration.settings?.environment === 'producao' ? 'producao' : 'homologacao') as FocusEnvironment

  const specificKey = EMISSION_TOKEN_KEYS[environment]
  const specificResult = await getIntegrationSecret(integration.id, companyId, specificKey)
  if (!specificResult.ok) return failure(specificResult.error, specificResult.status)

  let token = specificResult.data

  if (!token) {
    if (environment === 'producao') {
      // Regra de segurança aprovada explicitamente: NUNCA usar o token
      // legado em produção — ele não tem metadado que prove formalmente
      // a qual ambiente pertence.
      return success({ available: false, reason: 'production_token_missing' })
    }

    const legacyResult = await getIntegrationSecret(integration.id, companyId, LEGACY_TOKEN_KEY)
    if (!legacyResult.ok) return failure(legacyResult.error, legacyResult.status)
    token = legacyResult.data
  }

  if (!token) return success({ available: false, reason: 'token_missing' })

  return success({
    available: true,
    integration: {
      integrationId: integration.id,
      companyId,
      token,
      environment,
    },
  })
}
