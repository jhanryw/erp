/**
 * Health/config da fundação fiscal (Fase Fiscal 1, seção 8 do pedido).
 *
 * Dois níveis, deliberadamente separados:
 *   - `getFiscalHealth` — só leitura local (company_integrations,
 *     integration_secrets, company_fiscal_settings), sem chamada de rede.
 *     É o que a página de Configurações → Fiscal usa em todo carregamento.
 *   - `testFocusConnection` — chamada de rede real (`GET /v2/empresas`),
 *     só executada quando explicitamente acionada (botão "Testar conexão"
 *     na UI) — nunca automática, pra não haver surpresa de chamada externa
 *     em todo page load.
 *
 * O token NUNCA é incluído no retorno de nenhuma das duas funções.
 *
 * `company_fiscal_settings` ainda não existe em `database.types.ts` (não
 * regenerado nesta fase, por instrução explícita) — acesso via
 * `(admin as any)`, mesmo padrão já usado em outras integrações
 * (`outbox.service.ts`, `secrets.service.ts`). Débito técnico documentado
 * no relatório final da fase.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { resolveFocusIntegration } from './resolveFocusIntegration'
import { listFocusEmpresas } from '@/lib/integrations/focus/httpClient'
import { FocusApiError } from '@/lib/integrations/focus/types'
import type { FocusEnvironment } from '@/lib/integrations/focus/types'
import type { ServiceOutcome } from '@/services/produtos.service'

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

interface FiscalSettingsRow {
  nfe_enabled: boolean
  nfe_environment: FocusEnvironment
  nfce_enabled: boolean
  cnpj: string | null
  razao_social: string | null
  inscricao_estadual: string | null
  crt: number | null
  logradouro: string | null
  numero_endereco: string | null
  bairro: string | null
  municipio: string | null
  municipio_ibge: string | null
  uf: string | null
  cep: string | null
  certificate_status: string | null
  certificate_valid_until: string | null
  csc_id: string | null
}

const EMITENTE_REQUIRED_FIELDS: { key: keyof FiscalSettingsRow; label: string }[] = [
  { key: 'cnpj', label: 'CNPJ' },
  { key: 'razao_social', label: 'Razão social' },
  { key: 'inscricao_estadual', label: 'Inscrição estadual' },
  { key: 'crt', label: 'Regime tributário (CRT)' },
  { key: 'logradouro', label: 'Logradouro' },
  { key: 'numero_endereco', label: 'Número' },
  { key: 'bairro', label: 'Bairro' },
  { key: 'municipio', label: 'Município' },
  { key: 'municipio_ibge', label: 'Código IBGE do município' },
  { key: 'uf', label: 'UF' },
  { key: 'cep', label: 'CEP' },
]

export interface FiscalHealthStatus {
  fiscalSettingsConfigured: boolean
  nfeEnabled: boolean
  nfceEnabled: boolean
  environment: FocusEnvironment
  emitente: {
    complete: boolean
    missingFields: string[]
  }
  focusIntegration: {
    connected: boolean
    reason: 'integration_not_found' | 'integration_disabled' | 'token_missing' | null
  }
  /** Motor Fiscal Configurável Fase 2 — status de prontidão do certificado/CSC (seção 31 do pedido). */
  certificate: {
    configured: boolean
    status: string
    expiringSoon: boolean
    daysUntilExpiry: number | null
  }
  csc: { configured: boolean }
  readyForHomologacao: boolean
}

export async function getFiscalHealth(companyId: number): Promise<ServiceOutcome<FiscalHealthStatus>> {
  const admin = createAdminClient()

  const { data: settings, error: settingsError } = await (admin as any)
    .from('company_fiscal_settings')
    .select('nfe_enabled, nfe_environment, nfce_enabled, cnpj, razao_social, inscricao_estadual, crt, logradouro, numero_endereco, bairro, municipio, municipio_ibge, uf, cep, certificate_status, certificate_valid_until, csc_id')
    .eq('company_id', companyId)
    .maybeSingle() as { data: FiscalSettingsRow | null; error: { message: string } | null }

  if (settingsError) return failure(settingsError.message)

  const missingFields = settings
    ? EMITENTE_REQUIRED_FIELDS.filter((f) => !settings[f.key]).map((f) => f.label)
    : EMITENTE_REQUIRED_FIELDS.map((f) => f.label)

  const integrationResult = await resolveFocusIntegration(companyId)
  if (!integrationResult.ok) return failure(integrationResult.error, integrationResult.status)

  const focusIntegration = integrationResult.data.available
    ? { connected: true, reason: null }
    : { connected: false, reason: integrationResult.data.reason }

  const emitenteComplete = missingFields.length === 0
  const environment = settings?.nfe_environment ?? 'homologacao'

  // Motor Fiscal Configurável Fase 2 — informativo (checklist da seção 31).
  // NUNCA usado ainda pela emissão fiscal real (Focus continua com seu
  // próprio cadastro de certificado via /api/fiscal/empresa) — este cofre
  // é infraestrutura preparada pra um provider futuro (seção 26 do
  // pedido), não substitui o fluxo vigente.
  const certStatus = settings?.certificate_status ?? 'not_configured'
  const daysUntilExpiry = settings?.certificate_valid_until
    ? Math.ceil((new Date(settings.certificate_valid_until).getTime() - Date.now()) / 86_400_000)
    : null

  return success({
    fiscalSettingsConfigured: !!settings,
    nfeEnabled: settings?.nfe_enabled ?? false,
    nfceEnabled: settings?.nfce_enabled ?? false,
    environment,
    emitente: { complete: emitenteComplete, missingFields },
    focusIntegration,
    certificate: {
      configured: certStatus === 'valid' || certStatus === 'expired',
      status: certStatus,
      expiringSoon: daysUntilExpiry != null && daysUntilExpiry <= 30 && daysUntilExpiry >= 0,
      daysUntilExpiry,
    },
    csc: { configured: !!settings?.csc_id },
    readyForHomologacao: emitenteComplete && focusIntegration.connected && environment === 'homologacao',
  })
}

export interface FocusConnectionTestResult {
  connected: boolean
  environment?: FocusEnvironment
  empresasCount?: number
  error?: string
}

/**
 * Chamada de rede real — só invocada explicitamente (nunca em todo page
 * load). Usa `GET /v2/empresas` exclusivamente pra validar credencial,
 * nunca emite nada.
 */
export async function testFocusConnection(companyId: number): Promise<ServiceOutcome<FocusConnectionTestResult>> {
  const integrationResult = await resolveFocusIntegration(companyId)
  if (!integrationResult.ok) return failure(integrationResult.error, integrationResult.status)

  if (!integrationResult.data.available) {
    return success({ connected: false, error: `Integração Focus NFe não disponível (${integrationResult.data.reason}).` })
  }

  const { token, environment } = integrationResult.data.integration

  try {
    const empresas = await listFocusEmpresas({ token, environment })
    return success({ connected: true, environment, empresasCount: empresas.length })
  } catch (err) {
    if (err instanceof FocusApiError) {
      return success({ connected: false, environment, error: `Focus NFe retornou erro (${err.httpStatus}): ${err.mensagem ?? err.message}` })
    }
    return success({ connected: false, environment, error: err instanceof Error ? err.message : 'Erro desconhecido ao testar conexão.' })
  }
}
