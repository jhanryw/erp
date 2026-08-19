/**
 * Cadastro/atualização da empresa emitente na Focus NFe (Fase Fiscal 2A,
 * seções 2-3 do pedido).
 *
 * Fluxo: busca por CNPJ (`GET /v2/empresas?cnpj=`) — se existir, `PUT
 * /v2/empresas/{id}` (update); se não existir, `POST /v2/empresas`
 * (create). Nunca cria duplicata.
 *
 * `regime_tributario` é sempre lido de `company_fiscal_settings.crt` — é
 * o ÚNICO lugar do sistema que precisa mudar quando a empresa migrar MEI
 * (crt=4) → ME Simples Nacional (crt=1): atualizar a coluna e chamar este
 * serviço de novo. Mesmo CNPJ, mesmo `id` Focus, nenhum documento anterior
 * é afetado (ver relatório da fase, seção C).
 *
 * Certificado A1: o arquivo (base64) e a senha passam por este serviço só
 * em memória — nunca gravados em `company_fiscal_settings` nem em
 * nenhuma outra tabela, nunca logados (nem o base64, nem a senha, nem
 * metadado que os contenha). Descartados assim que a chamada HTTP retorna.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { resolveFocusIntegration } from './resolveFocusIntegration'
import { listFocusEmpresas, createFocusEmpresa, updateFocusEmpresa } from '@/lib/integrations/focus/httpClient'
import type { FocusEmpresaInput } from '@/lib/integrations/focus/types'
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

export interface SyncFocusEmpresaResult {
  action: 'created' | 'updated'
  focusEmpresaId: number
  certificadoValidoAte: string | null
}

/**
 * Sincroniza `company_fiscal_settings` pra Focus. NÃO monta o
 * `regime_tributario` a partir de nada além de `crt` — se `crt` estiver
 * ausente, falha cedo (nunca assume um regime).
 */
export async function syncFocusEmpresa(
  companyId: number,
  certificate?: SyncFocusEmpresaCertificate,
): Promise<ServiceOutcome<SyncFocusEmpresaResult>> {
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

  const integrationResult = await resolveFocusIntegration(companyId)
  if (!integrationResult.ok) return failure(integrationResult.error, integrationResult.status)
  if (!integrationResult.data.available) return failure(`Integração Focus NFe não disponível (${integrationResult.data.reason}).`, 422)

  const { token, environment } = integrationResult.data.integration

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
    ...(certificate ? { arquivo_certificado_base64: certificate.arquivoBase64, senha_certificado: certificate.senha } : {}),
  }

  try {
    const existing = await listFocusEmpresas({ token, environment }, settings.cnpj)
    const match = existing.find((e) => e.cnpj?.replace(/\D/g, '') === settings.cnpj!.replace(/\D/g, ''))

    const result = match
      ? await updateFocusEmpresa(match.id, input, { token, environment })
      : await createFocusEmpresa(input, { token, environment })

    return success({
      action: match ? 'updated' : 'created',
      focusEmpresaId: result.id,
      certificadoValidoAte: result.certificado_valido_ate ?? null,
    })
  } catch (err) {
    // Nunca incluir `input`/`certificate` na mensagem de erro — poderia
    // conter base64/senha do certificado se a Focus ecoasse o payload de
    // volta em erro de validação.
    const message = err instanceof Error ? err.message : 'Erro desconhecido ao sincronizar empresa com a Focus.'
    return failure(`Falha ao sincronizar empresa com a Focus NFe: ${message}`)
  }
}
