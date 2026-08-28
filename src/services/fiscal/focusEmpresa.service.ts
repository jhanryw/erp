/**
 * Cadastro/atualização da empresa emitente na Focus NFe — E, a partir
 * desta revisão (Motor Fiscal Configurável — Certificado/CSC),
 * sincronização real de certificado e CSC.
 *
 * ─── Mudança de arquitetura desta revisão ───────────────────────────────
 * ANTES: usava `resolveFocusIntegration` (token de EMISSÃO, host por
 * `environment`) — bug real, confirmado contra a doc oficial: `/v2/
 * empresas` "opera exclusivamente no ambiente de produção", nunca
 * homologação, e exige o TOKEN MESTRE da conta, não o token de emissão de
 * uma empresa específica.
 * AGORA: usa `resolveFocusManagementToken` (`master_token`) + sempre
 * `FOCUS_BASE_URLS.producao` — independente de `company_integrations.
 * settings.environment` (que continua controlando só a EMISSÃO de
 * documento, nunca tocado por este arquivo).
 *
 * `regime_tributario` é sempre lido de `company_fiscal_settings.crt` — é
 * o ÚNICO lugar do sistema que precisa mudar quando a empresa migrar MEI
 * (crt=4) → ME Simples Nacional (crt=1): atualizar a coluna e chamar este
 * serviço de novo. Mesmo CNPJ, mesmo `id` Focus, nenhum documento anterior
 * é afetado.
 *
 * Certificado A1 e CSC: os valores (base64/senha, CSC ID/Token) passam por
 * este serviço só em memória — nunca gravados em `company_fiscal_settings`
 * nem repassados adiante além desta chamada HTTP. Quem persiste os
 * SECRETS localmente (cifrados) é `certificateService.ts`, ANTES de
 * chamar este serviço — este arquivo só encaminha pra Focus e registra o
 * resultado da sincronização (`focusManagementSync`), nunca decide se o
 * secret local é válido.
 *
 * `external_account_id` (`company_integrations`) passa a cachear o `id`
 * Focus depois do primeiro sync bem-sucedido — evita reconsultar por CNPJ
 * toda vez; se o cache estiver obsoleto (empresa removida/recriada na
 * Focus, 404 no PUT), cai de volta pra busca por CNPJ automaticamente.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { resolveFocusManagementToken } from './resolveFocusManagementToken'
import { getCompanyIntegration, updateCompanyIntegration } from '@/services/integrations/company-integrations.service'
import { recordFocusManagementSync, makeSyncEntry } from './focusManagementSync'
import { listFocusEmpresas, createFocusEmpresa, updateFocusEmpresa } from '@/lib/integrations/focus/httpClient'
import { FocusApiError, type FocusEmpresa, type FocusEmpresaInput, type FocusRequestOptions } from '@/lib/integrations/focus/types'
import type { ServiceOutcome } from '@/services/produtos.service'

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

interface FiscalSettingsRow {
  cnpj: string | null
  razao_social: string | null
  nome_fantasia: string | null
  inscricao_estadual: string | null
  crt: number | null
  logradouro: string | null
  numero_endereco: string | null
  complemento: string | null
  bairro: string | null
  municipio: string | null
  uf: string | null
  cep: string | null
  telefone: string | null
  email: string | null
}

export interface SyncFocusEmpresaCertificate {
  arquivoBase64: string
  senha: string
}

export interface SyncFocusEmpresaCsc {
  /** Ambiente sincronizado — a Focus guarda os pares de homologação e produção simultaneamente na mesma empresa; este campo decide qual par recebe o valor, nunca os dois de uma vez. */
  environment: 'homologacao' | 'producao'
  cscId: string
  cscToken: string
}

export interface SyncFocusEmpresaOptions {
  certificate?: SyncFocusEmpresaCertificate
  csc?: SyncFocusEmpresaCsc
}

export interface SyncFocusEmpresaResult {
  action: 'created' | 'updated'
  focusEmpresaId: number
  certificadoValidoAte: string | null
}

/**
 * Usa o `external_account_id` já cacheado quando existe (evita round-trip
 * de busca por CNPJ); se a Focus devolver 404 pro ID cacheado (empresa
 * removida/recriada do lado de lá), cai automaticamente pra busca por
 * CNPJ — nunca falha só porque o cache ficou obsoleto.
 */
async function findOrCreateFocusEmpresa(
  cachedFocusId: number | null,
  cnpj: string,
  input: FocusEmpresaInput,
  options: FocusRequestOptions,
): Promise<{ empresa: FocusEmpresa; action: 'created' | 'updated' }> {
  if (cachedFocusId) {
    try {
      const empresa = await updateFocusEmpresa(cachedFocusId, input, options)
      return { empresa, action: 'updated' }
    } catch (err) {
      if (!(err instanceof FocusApiError) || err.httpStatus !== 404) throw err
      // cache obsoleto — segue pro fluxo de busca por CNPJ abaixo.
    }
  }

  const existing = await listFocusEmpresas(options, cnpj)
  const match = existing.find((e) => e.cnpj?.replace(/\D/g, '') === cnpj.replace(/\D/g, ''))
  const empresa = match ? await updateFocusEmpresa(match.id, input, options) : await createFocusEmpresa(input, options)
  return { empresa, action: match ? 'updated' : 'created' }
}

/**
 * Sincroniza `company_fiscal_settings` (+ opcionalmente certificado e/ou
 * CSC) pra Focus. NÃO monta o `regime_tributario` a partir de nada além
 * de `crt` — se `crt` estiver ausente, falha cedo (nunca assume um
 * regime).
 */
export async function syncFocusEmpresa(
  companyId: number,
  options?: SyncFocusEmpresaOptions,
): Promise<ServiceOutcome<SyncFocusEmpresaResult>> {
  const managementResult = await resolveFocusManagementToken(companyId)
  if (!managementResult.ok) return failure(managementResult.error, managementResult.status)
  if (!managementResult.data.available) {
    return failure(`Token mestre da Focus não disponível (${managementResult.data.reason}) — configure em Configurações → Fiscal.`, 422)
  }
  const { token } = managementResult.data.integration

  const integrationRowResult = await getCompanyIntegration(companyId, 'focus_nfe')
  if (!integrationRowResult.ok) return failure(integrationRowResult.error, integrationRowResult.status)
  const integrationRow = integrationRowResult.data
  if (!integrationRow) return failure('Integração Focus NFe não encontrada para esta empresa.', 404)

  const admin = createAdminClient()
  const { data: settings, error: settingsError } = await (admin as any)
    .from('company_fiscal_settings')
    .select('cnpj, razao_social, nome_fantasia, inscricao_estadual, crt, logradouro, numero_endereco, complemento, bairro, municipio, uf, cep, telefone, email')
    .eq('company_id', companyId)
    .maybeSingle() as { data: FiscalSettingsRow | null; error: { message: string } | null }

  if (settingsError) return failure(settingsError.message)
  if (!settings) return failure('company_fiscal_settings não cadastrado para esta empresa — cadastre CNPJ/razão social/endereço/CRT antes de sincronizar com a Focus.', 422)
  if (!settings.cnpj) return failure('CNPJ ausente em company_fiscal_settings.', 422)
  if (!settings.razao_social) return failure('Razão social ausente em company_fiscal_settings.', 422)
  if (!settings.crt) return failure('Regime tributário (CRT) ausente em company_fiscal_settings.', 422)

  const input: FocusEmpresaInput = {
    nome: settings.razao_social,
    nome_fantasia: settings.nome_fantasia ?? undefined,
    cnpj: settings.cnpj,
    inscricao_estadual: settings.inscricao_estadual ?? undefined,
    regime_tributario: settings.crt,
    logradouro: settings.logradouro ?? undefined,
    numero: settings.numero_endereco ?? undefined,
    complemento: settings.complemento ?? undefined,
    bairro: settings.bairro ?? undefined,
    municipio: settings.municipio ?? undefined,
    uf: settings.uf ?? undefined,
    cep: settings.cep ?? undefined,
    telefone: settings.telefone ?? undefined,
    email: settings.email ?? undefined,
    habilita_nfe: true,
    ...(options?.certificate ? { arquivo_certificado_base64: options.certificate.arquivoBase64, senha_certificado: options.certificate.senha } : {}),
    ...(options?.csc
      ? {
          habilita_nfce: true,
          ...(options.csc.environment === 'producao'
            ? { csc_nfce_producao: options.csc.cscToken, id_token_nfce_producao: options.csc.cscId }
            : { csc_nfce_homologacao: options.csc.cscToken, id_token_nfce_homologacao: options.csc.cscId }),
        }
      : {}),
  }

  // Gerenciamento SEMPRE contra produção, independente do ambiente de
  // emissão configurado — confirmado na doc oficial ("esta API opera
  // exclusivamente no ambiente de produção").
  const managementOptions: FocusRequestOptions = { token, environment: 'producao' }

  try {
    const cachedFocusId = integrationRow.external_account_id ? Number(integrationRow.external_account_id) : null
    const { empresa, action } = await findOrCreateFocusEmpresa(cachedFocusId, settings.cnpj, input, managementOptions)

    await updateCompanyIntegration(integrationRow.id, companyId, { externalAccountId: String(empresa.id) })

    await recordFocusManagementSync(companyId, integrationRow, {
      company: makeSyncEntry('success'),
      ...(options?.certificate ? { certificate: makeSyncEntry('success') } : {}),
      ...(options?.csc ? { csc: { environment: options.csc.environment, entry: makeSyncEntry('success') } } : {}),
    })

    return success({
      action,
      focusEmpresaId: empresa.id,
      certificadoValidoAte: empresa.certificado_valido_ate ?? null,
    })
  } catch (err) {
    // Nunca incluir `input`/`certificate`/`csc` na mensagem de erro —
    // poderia conter base64/senha/CSC Token se a Focus ecoasse o payload
    // de volta em erro de validação.
    const message = err instanceof Error ? err.message : 'Erro desconhecido ao sincronizar empresa com a Focus.'

    await recordFocusManagementSync(companyId, integrationRow, {
      company: makeSyncEntry('error', message),
      ...(options?.certificate ? { certificate: makeSyncEntry('error', message) } : {}),
      ...(options?.csc ? { csc: { environment: options.csc.environment, entry: makeSyncEntry('error', message) } } : {}),
    }).catch(() => {
      // Falha ao REGISTRAR o erro nunca deve mascarar o erro real — segue pro `return failure` abaixo de qualquer forma.
    })

    return failure(`Falha ao sincronizar empresa com a Focus NFe: ${message}`)
  }
}
