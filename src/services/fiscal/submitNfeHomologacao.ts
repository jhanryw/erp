/**
 * Transmission service — Fase Fiscal 2B, seção 6-8 do pedido.
 *
 * `submitNfeHomologacao(saleId, companyId)` é o ÚNICO ponto do projeto que
 * chama `POST /v2/nfe` (emissão real). Só em homologação — bloqueia
 * produção explicitamente antes de qualquer outra coisa. Nunca chamado
 * automaticamente (sem outbox/sale.completed nesta fase) — só via
 * `POST /api/fiscal/nfe/emitir-homologacao`, acionado manualmente por um
 * admin.
 *
 * ─── Idempotência (seção 7 do pedido) ────────────────────────────────────
 *
 * `provider_ref` é DETERMINÍSTICO — `qarvon-{company_id}-{sale_id}-nfe`
 * (`buildProviderRef`) — nunca um UUID aleatório por tentativa. Isso é o
 * que permite retry seguro: a MESMA ref é reenviada em toda tentativa pra
 * uma venda, nunca uma nova.
 *
 * Fluxo de proteção contra duplo clique / retry / timeout / concorrência:
 *   1. Busca o `fiscal_documents` mais recente pra (company_id, sale_id,
 *      document_type='nfe'). Se não existir, tenta criar um novo com
 *      status='draft' — se essa criação colidir (23505, UNIQUE
 *      provider+provider_ref) porque outra requisição concorrente já
 *      criou o mesmo ref no meio do caminho, RE-busca a linha e trata
 *      como "já existe", nunca insere uma segunda.
 *   2. Se a linha já está `authorized` → devolve o resultado existente,
 *      NUNCA tenta emitir de novo (mesmo padrão do UNIQUE parcial do
 *      banco — aqui é a primeira linha de defesa, o UNIQUE é a segunda).
 *   3. Se a linha está `pending` → o resultado da tentativa anterior é
 *      DESCONHECIDO (pode ter timeado, pode estar processando de verdade).
 *      Consulta a Focus pela MESMA ref (`GET /v2/nfe/{ref}`) ANTES de
 *      qualquer outra coisa — nunca reemite às cegas. Atualiza a linha
 *      conforme a resposta real e devolve — nunca chama `POST /v2/nfe`
 *      de novo nesse caminho.
 *   4. Qualquer outro status (`draft`/`validation_failed`/
 *      `submission_error`/`authorization_failed`/`cancellation_failed`) →
 *      seguro reemitir reaproveitando a MESMA linha e o MESMO ref.
 *   5. `cancelled` é tratado como terminal (mesmo padrão de `authorized`)
 *      — cancelamento não é implementado nesta fase, mas uma vez
 *      cancelado não faz sentido reemitir automaticamente pro mesmo ref.
 *   6. Se a chamada HTTP falhar por timeout/rede (resultado
 *      GENUINAMENTE desconhecido, nem a Focus respondeu), a linha fica
 *      `pending` com uma mensagem explicando isso — a PRÓXIMA chamada cai
 *      no passo 3 (consulta antes de reemitir), nunca gera um ref novo.
 *
 * ─── Máquina de estados (seção 8 do pedido) ──────────────────────────────
 *
 * `erro_autorizacao` da Focus NUNCA é tratado como suficiente sozinho —
 * `status_sefaz`/`mensagem_sefaz` são sempre persistidos junto (podem ser
 * rejeição real da SEFAZ OU falha técnica da Focus, indistinguíveis só
 * pelo `status`, confirmado na Fase 1). Erro síncrono da Focus (400/422,
 * a chamada nem chegou na SEFAZ) vira `submission_error`, com
 * `submission_error_code`/`submission_error_message` — nunca confundido
 * com `authorization_failed`.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { resolveFocusIntegration } from './resolveFocusIntegration'
import { loadSaleFiscalContext, FiscalContextError } from './loadSaleFiscalContext'
import { validateFiscalReadiness } from './validateFiscalReadiness'
import { buildNfePayload, FiscalBuildError } from './buildNfePayload'
import { buildFiscalDocumentSnapshot } from './buildFiscalSnapshot'
import { issueFocusNfe, consultFocusNfe } from '@/lib/integrations/focus/httpClient'
import { FocusApiError, type FocusNfeConsultaResponse } from '@/lib/integrations/focus/types'
import type { ServiceOutcome } from '@/services/produtos.service'
import type { FiscalValidationError } from './types'

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

export type FiscalDocumentDomainStatus =
  | 'draft' | 'validation_failed' | 'pending' | 'authorized'
  | 'authorization_failed' | 'submission_error' | 'cancelled' | 'cancellation_failed'

export interface SubmitNfeResult {
  fiscalDocumentId: number
  providerRef: string
  status: FiscalDocumentDomainStatus
  accessKey: string | null
  number: string | null
  series: string | null
  authorizationProtocol: string | null
  statusSefaz: string | null
  statusMessage: string | null
  submissionErrorCode: string | null
  submissionErrorMessage: string | null
  xmlPath: string | null
  danfePath: string | null
  validationErrors: FiscalValidationError[]
}

interface FiscalDocumentRow {
  id: number
  status: FiscalDocumentDomainStatus
  provider_ref: string
  number: string | null
  series: string | null
  access_key: string | null
  authorization_protocol: string | null
  status_sefaz: string | null
  status_message: string | null
  submission_error_code: string | null
  submission_error_message: string | null
  xml_path: string | null
  danfe_path: string | null
}

/** Determinístico — nunca um UUID aleatório. Ver comentário do arquivo. */
export function buildProviderRef(companyId: number, saleId: number): string {
  return `qarvon-${companyId}-${saleId}-nfe`
}

function mapFocusStatus(status: FocusNfeConsultaResponse['status']): FiscalDocumentDomainStatus {
  switch (status) {
    case 'autorizado': return 'authorized'
    case 'processando_autorizacao': return 'pending'
    case 'erro_autorizacao': return 'authorization_failed'
    case 'cancelado': return 'cancelled'
    case 'erro_cancelamento': return 'cancellation_failed'
  }
}

function rowToResult(row: FiscalDocumentRow, validationErrors: FiscalValidationError[] = []): SubmitNfeResult {
  return {
    fiscalDocumentId: row.id,
    providerRef: row.provider_ref,
    status: row.status,
    accessKey: row.access_key,
    number: row.number,
    series: row.series,
    authorizationProtocol: row.authorization_protocol,
    statusSefaz: row.status_sefaz,
    statusMessage: row.status_message,
    submissionErrorCode: row.submission_error_code,
    submissionErrorMessage: row.submission_error_message,
    xmlPath: row.xml_path,
    danfePath: row.danfe_path,
    validationErrors,
  }
}

const FISCAL_DOCUMENT_SELECT = 'id, status, provider_ref, number, series, access_key, authorization_protocol, status_sefaz, status_message, submission_error_code, submission_error_message, xml_path, danfe_path'

/**
 * Busca a linha mais recente pra (company, sale, nfe) ou cria uma nova em
 * 'draft'. Concorrência segura via UNIQUE(provider, provider_ref) — uma
 * corrida perdida na criação vira uma re-busca, nunca uma segunda linha.
 */
async function getOrCreateFiscalDocument(
  admin: ReturnType<typeof createAdminClient>,
  companyId: number,
  saleId: number,
  providerRef: string,
  environment: string,
): Promise<FiscalDocumentRow> {
  const { data: existing } = await (admin as any)
    .from('fiscal_documents')
    .select(FISCAL_DOCUMENT_SELECT)
    .eq('company_id', companyId)
    .eq('sale_id', saleId)
    .eq('document_type', 'nfe')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existing) return existing as FiscalDocumentRow

  const { data: created, error: insertError } = await (admin as any)
    .from('fiscal_documents')
    .insert({ company_id: companyId, sale_id: saleId, document_type: 'nfe', provider: 'focus_nfe', environment, provider_ref: providerRef, status: 'draft' })
    .select(FISCAL_DOCUMENT_SELECT)
    .single()

  if (!insertError) return created as FiscalDocumentRow

  if (insertError.code === '23505') {
    // Corrida perdida — outra requisição concorrente criou a mesma linha
    // entre o SELECT e o INSERT acima. Re-busca, nunca insere de novo.
    const { data: raceWinner } = await (admin as any)
      .from('fiscal_documents')
      .select(FISCAL_DOCUMENT_SELECT)
      .eq('company_id', companyId)
      .eq('sale_id', saleId)
      .eq('document_type', 'nfe')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (raceWinner) return raceWinner as FiscalDocumentRow
  }

  throw new Error(`Falha ao criar fiscal_documents pra venda ${saleId}: ${insertError.message}`)
}

async function applyFocusResponse(
  admin: ReturnType<typeof createAdminClient>,
  fiscalDocumentId: number,
  response: FocusNfeConsultaResponse,
): Promise<FiscalDocumentDomainStatus> {
  const domainStatus = mapFocusStatus(response.status)

  const patch: Record<string, unknown> = {
    status: domainStatus,
    provider_payload: response,
    status_sefaz: response.status_sefaz != null ? String(response.status_sefaz) : null,
    status_message: response.mensagem_sefaz ?? null,
  }

  if (domainStatus === 'authorized') {
    patch.number = response.numero ?? null
    patch.series = response.serie ?? null
    patch.access_key = response.chave_nfe ?? null
    patch.authorization_protocol = response.protocolo_nota_fiscal?.numero_protocolo ?? null
    patch.xml_path = response.caminho_xml_nota_fiscal ?? null
    patch.danfe_path = response.caminho_danfe ?? null
    patch.authorized_at = new Date().toISOString()
  }

  await (admin as any).from('fiscal_documents').update(patch).eq('id', fiscalDocumentId)
  return domainStatus
}

/**
 * Consulta a Focus pela ref existente e atualiza a linha — nunca chama
 * `POST /v2/nfe` aqui. Usado quando uma linha `pending` já existe (retry
 * seguro) e por `consultNfeStatus.ts` (polling manual explícito).
 */
export async function consultAndUpdateFiscalDocument(
  fiscalDocumentId: number,
  providerRef: string,
  companyId: number,
): Promise<ServiceOutcome<SubmitNfeResult>> {
  const admin = createAdminClient()

  const integrationResult = await resolveFocusIntegration(companyId)
  if (!integrationResult.ok) return failure(integrationResult.error, integrationResult.status)
  if (!integrationResult.data.available) return failure(`Integração Focus NFe não disponível (${integrationResult.data.reason}).`, 422)

  const { token, environment } = integrationResult.data.integration

  try {
    const response = await consultFocusNfe(providerRef, { token, environment })
    const status = await applyFocusResponse(admin, fiscalDocumentId, response)

    const { data: row } = await (admin as any)
      .from('fiscal_documents')
      .select(FISCAL_DOCUMENT_SELECT)
      .eq('id', fiscalDocumentId)
      .single()

    return success(rowToResult({ ...(row as FiscalDocumentRow), status }))
  } catch (err) {
    const message = err instanceof FocusApiError ? `Focus retornou erro (${err.httpStatus}): ${err.mensagem ?? err.message}` : err instanceof Error ? err.message : 'Erro desconhecido ao consultar NF-e.'
    return failure(message)
  }
}

export async function submitNfeHomologacao(saleId: number, companyId: number): Promise<ServiceOutcome<SubmitNfeResult>> {
  const admin = createAdminClient()

  // ─── Gate de ambiente — bloqueia produção explicitamente ───────────────
  const { data: settings } = await (admin as any)
    .from('company_fiscal_settings')
    .select('nfe_environment, nfe_enabled')
    .eq('company_id', companyId)
    .maybeSingle()

  if (!settings) return failure('Configuração fiscal da empresa não encontrada (company_fiscal_settings).', 422)
  if (!settings.nfe_enabled) return failure('Emissão de NF-e não habilitada (company_fiscal_settings.nfe_enabled=false).', 422)
  if (settings.nfe_environment !== 'homologacao') {
    return failure('Bloqueado: esta rota só emite em homologação. company_fiscal_settings.nfe_environment não é "homologacao".', 403)
  }

  const providerRef = buildProviderRef(companyId, saleId)
  const existingRow = await getOrCreateFiscalDocument(admin, companyId, saleId, providerRef, 'homologacao')

  // ─── Idempotência: linha terminal (authorized/cancelled) nunca reemite ──
  if (existingRow.status === 'authorized' || existingRow.status === 'cancelled') {
    return success(rowToResult(existingRow))
  }

  // ─── Idempotência: pending → consulta antes de qualquer coisa, nunca reemite às cegas ──
  if (existingRow.status === 'pending') {
    return consultAndUpdateFiscalDocument(existingRow.id, existingRow.provider_ref, companyId)
  }

  // ─── Resolve integração/token ────────────────────────────────────────────
  const integrationResult = await resolveFocusIntegration(companyId)
  if (!integrationResult.ok) return failure(integrationResult.error, integrationResult.status)
  if (!integrationResult.data.available) {
    return failure(`Integração Focus NFe não disponível (${integrationResult.data.reason}).`, 422)
  }
  const { token, environment } = integrationResult.data.integration
  if (environment !== 'homologacao') {
    return failure('Bloqueado: a integração Focus NFe resolvida não está configurada para homologação.', 403)
  }

  // ─── Carrega contexto + valida ───────────────────────────────────────────
  let context
  try {
    context = await loadSaleFiscalContext({ saleId, companyId, providerRef, environment: 'homologacao' })
  } catch (err) {
    if (err instanceof FiscalContextError) return failure(err.message, 404)
    throw err
  }

  const validationErrors = validateFiscalReadiness(context)
  if (validationErrors.length > 0) {
    await (admin as any).from('fiscal_documents').update({
      status: 'validation_failed',
      fiscal_context_snapshot: context,
      submission_error_code: 'local_validation_failed',
      submission_error_message: validationErrors.map((e) => e.message).join('; '),
    }).eq('id', existingRow.id)

    return success(rowToResult({ ...existingRow, status: 'validation_failed' }, validationErrors))
  }

  // ─── Monta payload + snapshot ────────────────────────────────────────────
  let payload
  let snapshot
  try {
    payload = buildNfePayload(context)
    snapshot = buildFiscalDocumentSnapshot(context)
  } catch (err) {
    const message = err instanceof FiscalBuildError ? err.message : 'Falha inesperada ao montar o payload.'
    await (admin as any).from('fiscal_documents').update({
      status: 'validation_failed',
      fiscal_context_snapshot: context,
      submission_error_code: 'local_build_failed',
      submission_error_message: message,
    }).eq('id', existingRow.id)
    return success(rowToResult({ ...existingRow, status: 'validation_failed' }, [{ code: 'local_build_failed', message }]))
  }

  // ─── Persiste intenção ANTES de transmitir (rastro mesmo se o processo cair) ──
  await (admin as any).from('fiscal_documents').update({
    request_payload: payload,
    fiscal_context_snapshot: context,
    issued_at: new Date().toISOString(),
  }).eq('id', existingRow.id)

  await (admin as any).from('fiscal_document_items').delete().eq('fiscal_document_id', existingRow.id)
  if (snapshot.items.length > 0) {
    await (admin as any).from('fiscal_document_items').insert(
      snapshot.items.map((item) => ({ ...item, fiscal_document_id: existingRow.id, company_id: companyId })),
    )
  }

  // ─── Transmite ────────────────────────────────────────────────────────────
  try {
    const response = await issueFocusNfe(providerRef, payload, { token, environment })
    const status = await applyFocusResponse(admin, existingRow.id, response)

    const { data: finalRow } = await (admin as any)
      .from('fiscal_documents')
      .select(FISCAL_DOCUMENT_SELECT)
      .eq('id', existingRow.id)
      .single()

    return success(rowToResult({ ...(finalRow as FiscalDocumentRow), status }))
  } catch (err) {
    if (err instanceof FocusApiError) {
      // Erro síncrono — a SEFAZ nunca viu a tentativa. Nunca confundir com authorization_failed.
      await (admin as any).from('fiscal_documents').update({
        status: 'submission_error',
        submission_error_code: err.codigo ?? String(err.httpStatus),
        submission_error_message: err.mensagem ?? err.message,
      }).eq('id', existingRow.id)

      return success(rowToResult({
        ...existingRow,
        status: 'submission_error',
        submission_error_code: err.codigo ?? String(err.httpStatus),
        submission_error_message: err.mensagem ?? err.message,
      }))
    }

    // Timeout/falha de rede — resultado GENUINAMENTE desconhecido. Fica
    // pending; a PRÓXIMA chamada consulta antes de reemitir (nunca gera
    // ref novo, nunca reemite às cegas).
    const message = err instanceof Error ? err.message : 'Erro desconhecido ao transmitir.'
    await (admin as any).from('fiscal_documents').update({
      status: 'pending',
      status_message: `Resultado desconhecido após falha de transmissão: ${message}`,
    }).eq('id', existingRow.id)

    return success(rowToResult({ ...existingRow, status: 'pending', status_message: `Resultado desconhecido após falha de transmissão: ${message}` }))
  }
}
