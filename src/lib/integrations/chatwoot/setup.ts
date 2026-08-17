/**
 * Operação administrativa de setup (Fase 4, seção 40 do pedido) —
 * `testChatwootConnection` (seção 41) + `ensureChatwootCustomAttributes`,
 * combinadas numa única chamada idempotente, pra rodar UMA vez ao ativar
 * a integração — nunca dentro do fluxo de sincronização por evento.
 *
 * Deliberadamente NÃO muda `company_integrations.status` pra `'active'`
 * automaticamente em caso de sucesso — confirma que token/conexão/atributos
 * estão OK e devolve o resultado; ativar é uma decisão explícita separada
 * (`updateCompanyIntegration(..., { status: 'active' })`), pra nunca abrir
 * outbound "sozinho" sem confirmação humana. Em caso de falha TRANSITÓRIA
 * (timeout/rede), só registra `last_error` — nunca marca `status='error'`
 * por um timeout pontual (seção 42 do pedido). Só erro claramente
 * permanente (401/403/URL inválida) marca `status='error'`.
 */

import { getCompanyIntegration, updateCompanyIntegration } from '@/services/integrations/company-integrations.service'
import { getIntegrationSecret } from '@/services/integrations/secrets.service'
import { testChatwootConnection, isPermanentChatwootError, type ChatwootClientConfig } from './client'
import { ensureChatwootCustomAttributes, type EnsureCustomAttributesResult } from './customAttributes'
import type { ServiceOutcome } from '@/services/produtos.service'

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

export interface SetupChatwootIntegrationResult {
  connectionOk: true
  customAttributes: EnsureCustomAttributesResult
}

export async function setupChatwootIntegration(companyId: number): Promise<ServiceOutcome<SetupChatwootIntegrationResult>> {
  const integrationResult = await getCompanyIntegration(companyId, 'chatwoot')
  if (!integrationResult.ok) return failure(integrationResult.error, integrationResult.status)
  const integration = integrationResult.data
  if (!integration) return failure('Nenhuma integração Chatwoot configurada para esta empresa.', 404)

  const apiTokenResult = await getIntegrationSecret(integration.id, companyId, 'api_token')
  if (!apiTokenResult.ok) return failure(apiTokenResult.error, apiTokenResult.status)
  if (!apiTokenResult.data) return failure('api_token não configurado — use setIntegrationSecret() antes do setup.', 422)

  const baseUrl = typeof integration.settings.base_url === 'string' ? integration.settings.base_url : null
  if (!baseUrl) return failure('settings.base_url não configurado.', 422)
  if (!integration.external_account_id) return failure('external_account_id não configurado.', 422)

  const config: ChatwootClientConfig = { baseUrl, accountId: integration.external_account_id, apiToken: apiTokenResult.data }

  const testResult = await testChatwootConnection(config)
  if (!testResult.ok) {
    const isTransient = testResult.error.kind === 'timeout' || testResult.error.kind === 'network'
    if (!isTransient) {
      await updateCompanyIntegration(integration.id, companyId, { status: 'error', lastError: testResult.error.message })
    } else {
      await updateCompanyIntegration(integration.id, companyId, { lastError: testResult.error.message })
    }
    return failure(`Teste de conexão falhou: ${testResult.error.message}`)
  }

  const attributesResult = await ensureChatwootCustomAttributes(config)
  if (!attributesResult.ok) return failure(attributesResult.error, attributesResult.status)

  await updateCompanyIntegration(integration.id, companyId, { lastError: null })

  return success({ connectionOk: true, customAttributes: attributesResult.data })
}

// Reexportado por conveniência — evita import duplicado em quem só precisa
// classificar erro permanente vs retryable fora deste módulo.
export { isPermanentChatwootError }
