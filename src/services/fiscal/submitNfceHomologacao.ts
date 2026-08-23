/**
 * Transmission service de NFC-e — Fase Fiscal 4E.
 *
 * `submitNfceHomologacao(saleId, companyId)` é o ÚNICO ponto do projeto que
 * chama `POST /v2/nfce`. Só em homologação — bloqueia produção
 * explicitamente antes de qualquer outra coisa (mesmo padrão de
 * `submitNfeHomologacao.ts`). Nunca chamado automaticamente nesta fase —
 * nenhuma rota/UI foi conectada ainda (fora de escopo desta fase, ver
 * `docs/fiscal-fase4-nfce-arquitetura-proposta.md`, fase 4F).
 *
 * ─── Reaproveitamento de infraestrutura (Fase 4, decisão aprovada) ───────
 *
 * `claimFiscalEmission`/`beginFiscalTransmission`/`completeFiscalEmission`/
 * `fetchCurrentFiscalDocumentRow`/`rowToResult` são IMPORTADOS de
 * `submitNfeHomologacao.ts` (só exportados lá, ZERO mudança de lógica —
 * ver comentário no topo daquelas declarações). Mesmo claim/lease/begin/
 * complete/reconciliação já testados contra Postgres real — nada disso é
 * redefinido aqui. `document_type='nfce'` é passado explicitamente em
 * todo ponto que chama a RPC de claim.
 *
 * ─── O que é DIFERENTE de NF-e ───────────────────────────────────────────
 *
 * - `validateNfceReadiness` (nunca exige destinatário/endereço/IBGE).
 * - `buildNfcePayload`/`buildNfceDocumentSnapshot` (payload sem endereço,
 *   CFOP interno fixo, `presenca_comprador` restrito a presencial).
 * - `issueFocusNfce`/`consultFocusNfce` (`POST`/`GET /v2/nfce`).
 * - `company_fiscal_settings.nfce_enabled`/`nfce_environment` — gate
 *   SEPARADO do de NF-e (decisão aprovada: nunca um switch único).
 * - `mapFocusNfceStatus` inclui `'denegado'` (status real de NFC-e sem
 *   equivalente confirmado em NF-e) → mapeado pra `authorization_failed`
 *   (mesmo bucket de `erro_autorizacao` — SEFAZ recusou, `status_sefaz`/
 *   `mensagem_sefaz` sempre persistidos junto, nunca perdido).
 * - `loadSaleFiscalContext` chamado com `operationOverrides` fixos
 *   (`presencaComprador: 1`, `modalidadeFrete: 9`) — NFC-e só é usada por
 *   `resolveFiscalDocumentType` pra venda presencial/retirada, nunca lida
 *   do contexto genérico (que hoje hardcoda `presencaComprador: 2`,
 *   pensado pra NF-e/ecommerce).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { resolveFocusIntegration } from './resolveFocusIntegration'
import { loadSaleFiscalContext, FiscalContextError } from './loadSaleFiscalContext'
import { validateNfceReadiness } from './validateFiscalReadiness'
import { buildNfcePayload } from './buildNfcePayload'
import { FiscalBuildError } from './buildNfePayload'
import { buildNfceDocumentSnapshot } from './buildFiscalSnapshot'
import { FiscalRuleNotImplementedError } from '@/lib/fiscal/taxRules'
import { issueFocusNfce, consultFocusNfce } from '@/lib/integrations/focus/httpClient'
import { FocusApiError, type FocusNfceConsultaResponse } from '@/lib/integrations/focus/types'
import {
  buildProviderRef,
  claimFiscalEmission,
  beginFiscalTransmission,
  completeFiscalEmission,
  fetchCurrentFiscalDocumentRow,
  rowToResult,
  FISCAL_DOCUMENT_SELECT,
  type FiscalDocumentRow,
  type FiscalDocumentDomainStatus,
  type SubmitNfeResult,
} from './submitNfeHomologacao'
import type { ServiceOutcome } from '@/services/produtos.service'

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

/**
 * `denegado` (SEFAZ recusa por motivo cadastral do emitente, distinto de
 * rejeição por dado da nota) não tem status próprio na máquina de estados
 * de `fiscal_documents` (CHECK só tem 8 valores compartilhados com NF-e,
 * ver migration 20260821) — mapeado pra `authorization_failed`, mesmo
 * bucket de `erro_autorizacao`. `status_sefaz`/`status_message` preservam
 * a distinção real, nunca perdida.
 */
function mapFocusNfceStatus(status: FocusNfceConsultaResponse['status']): FiscalDocumentDomainStatus {
  switch (status) {
    case 'autorizado': return 'authorized'
    case 'processando_autorizacao': return 'pending'
    case 'erro_autorizacao': return 'authorization_failed'
    case 'denegado': return 'authorization_failed'
    case 'cancelado': return 'cancelled'
    case 'erro_cancelamento': return 'cancellation_failed'
  }
}

export class FocusAccessKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FocusAccessKeyError'
  }
}

/**
 * Normaliza `chave_nfe` da resposta Focus pra chave de acesso real (44
 * dígitos numéricos — `fiscal_documents.access_key CHAR(44)`) — achado
 * real (venda 626, tentativa 3: Postgres rejeitou com "value too long for
 * type character(44)"). CONFIRMADO por leitura direta (curl bruto, não
 * resumo de IA) do exemplo oficial `"NFCeAutorizada"` em
 * `doc.focusnfe.com.br/reference/emitir_nfce.md`:
 * `"chave_nfe": "NFe41190612345678000123650010000000121743484310"` — 47
 * caracteres: prefixo literal `"NFe"` (3 chars) + 44 dígitos numéricos (o
 * mesmo valor, sem o prefixo, reaparece em `qrcode_url` — `p=
 * 41190612345678000123650010000000121743484310|...`). O mesmo padrão foi
 * confirmado em `emitir_nfe.md` (exemplo `"NFeAutorizada"`) — o bug
 * EXISTE IGUALMENTE do lado de NF-e (`submitNfeHomologacao.ts`), mas não
 * foi corrigido aqui — fora de escopo desta correção (NFC-e only).
 *
 * NUNCA trunca silenciosamente pra caber em 44 chars — trunca seria pior
 * que o erro do Postgres (uma chave de acesso ERRADA persistida com
 * aparência de válida). Se, depois de remover um prefixo `"NFe"` literal,
 * o resultado não for exatamente 44 dígitos numéricos, lança com uma
 * mensagem diagnóstica clara — nunca deixa a coluna receber lixo.
 */
export function extractFocusAccessKey(chaveNfe: string | null | undefined): string {
  if (!chaveNfe) {
    throw new FocusAccessKeyError('Focus retornou status "autorizado" sem chave_nfe na resposta — não é seguro persistir a autorização sem a chave de acesso.')
  }
  const semPrefixo = chaveNfe.startsWith('NFe') ? chaveNfe.slice(3) : chaveNfe
  if (!/^\d{44}$/.test(semPrefixo)) {
    throw new FocusAccessKeyError(
      `chave_nfe da Focus não corresponde a uma chave de acesso válida (esperado 44 dígitos numéricos após remover um eventual prefixo "NFe"; recebido "${chaveNfe}" — ${semPrefixo.length} caractere(s) depois de normalizar) — nada foi persistido.`,
    )
  }
  return semPrefixo
}

async function applyFocusNfceResponse(
  admin: ReturnType<typeof createAdminClient>,
  fiscalDocumentId: number,
  response: FocusNfceConsultaResponse,
): Promise<FiscalDocumentDomainStatus> {
  const domainStatus = mapFocusNfceStatus(response.status)

  const patch: Record<string, unknown> = {
    status: domainStatus,
    provider_payload: response,
    status_sefaz: response.status_sefaz != null ? String(response.status_sefaz) : null,
    status_message: response.mensagem_sefaz ?? null,
  }

  // Mesmo fechamento do risco residual #2 já aplicado em NF-e — ver
  // comentário completo em submitNfeHomologacao.ts:applyFocusResponse.
  if (domainStatus !== 'pending') {
    patch.submission_started_at = null
  }

  if (domainStatus === 'authorized') {
    patch.number = response.numero ?? null
    patch.series = response.serie ?? null
    // Lança FocusAccessKeyError se malformada — nunca persiste lixo, nunca
    // deixa o Postgres reportar um erro genérico de coluna.
    patch.access_key = extractFocusAccessKey(response.chave_nfe)
    // Débito técnico fechado (achado da auditoria da venda 626, item 1):
    // `numero_protocolo` é FLAT na resposta de NFC-e (`FocusNfceConsultaResponse`,
    // diferente de NF-e, que aninha em `protocolo_nota_fiscal.numero_protocolo`)
    // — nunca era mapeado pra `authorization_protocol`, ficava sempre null
    // mesmo em nota autorizada.
    patch.authorization_protocol = response.numero_protocolo ?? null
    patch.xml_path = response.caminho_xml_nota_fiscal ?? null
    patch.danfe_path = response.caminho_danfe ?? null
    patch.authorized_at = new Date().toISOString()
  }

  // ACHADO REAL (venda 626, item 7 da auditoria): esta chamada NUNCA
  // checava `error` — uma falha de escrita (ex.: a MESMA rejeição
  // CHAR(44) de access_key, ou qualquer outro erro de banco) era
  // SILENCIOSAMENTE ignorada, e a função devolvia `domainStatus`
  // ('authorized') mesmo que NADA tivesse sido gravado —
  // `consultAndUpdateNfceDocument` repassava esse status pro chamador
  // (rota → UI), que mostrava "Autorizada" com a persistência
  // efetivamente FALHA. Corrigido: qualquer erro de escrita agora
  // propaga (lança), nunca é engolido — o chamador cai no branch de
  // erro e NUNCA afirma um status que não foi persistido.
  const { error: updateError } = await (admin as any).from('fiscal_documents').update(patch).eq('id', fiscalDocumentId)
  if (updateError) {
    const context = domainStatus === 'authorized'
      ? 'Focus confirmou autorização, mas a gravação no banco falhou — NUNCA considere esta NFC-e autorizada até uma reconciliação confirmar o estado real persistido.'
      : `Falha ao persistir status fiscal (documento ${fiscalDocumentId}).`
    throw new Error(`${context} Causa: ${updateError.message}`)
  }

  return domainStatus
}

/**
 * Consulta a Focus pela ref existente e atualiza a linha — nunca chama
 * `POST /v2/nfce` aqui. Mesmo papel de `consultAndUpdateFiscalDocument`
 * (NF-e): usado quando o claim devolve `reconciliation_required`. Mesma
 * decisão de escrever SEM exigir `claim_token` (consulta idempotente, ver
 * comentário completo na versão de NF-e).
 */
export async function consultAndUpdateNfceDocument(
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
    const response = await consultFocusNfce(providerRef, { token, environment })
    const status = await applyFocusNfceResponse(admin, fiscalDocumentId, response)

    const { data: row } = await (admin as any)
      .from('fiscal_documents')
      .select(FISCAL_DOCUMENT_SELECT)
      .eq('id', fiscalDocumentId)
      .single()

    return success(rowToResult({ ...(row as FiscalDocumentRow), status }))
  } catch (err) {
    // Mesmo cenário A de recuperação de crash de NF-e — 404/nao_encontrado
    // confirma que a Focus nunca recebeu essa ref, libera retry seguro com
    // a MESMA provider_ref.
    if (err instanceof FocusApiError && (err.httpStatus === 404 || err.codigo === 'nao_encontrado')) {
      await (admin as any).from('fiscal_documents').update({
        status: 'submission_error',
        submission_error_code: err.codigo ?? '404',
        submission_error_message: 'Focus confirmou que esta referência nunca foi recebida — seguro tentar uma nova transmissão.',
        submission_started_at: null,
      }).eq('id', fiscalDocumentId)

      const { data: row } = await (admin as any)
        .from('fiscal_documents')
        .select(FISCAL_DOCUMENT_SELECT)
        .eq('id', fiscalDocumentId)
        .single()

      return success(rowToResult(row as FiscalDocumentRow))
    }

    const message = err instanceof FocusApiError ? `Focus retornou erro (${err.httpStatus}): ${err.mensagem ?? err.message}` : err instanceof Error ? err.message : 'Erro desconhecido ao consultar NFC-e.'
    return failure(message)
  }
}

export async function submitNfceHomologacao(saleId: number, companyId: number): Promise<ServiceOutcome<SubmitNfeResult>> {
  const admin = createAdminClient()

  // ─── Gate de ambiente — SEPARADO de NF-e (decisão aprovada, Fase 4) ─────
  const { data: settings } = await (admin as any)
    .from('company_fiscal_settings')
    .select('nfce_environment, nfce_enabled')
    .eq('company_id', companyId)
    .maybeSingle()

  if (!settings) return failure('Configuração fiscal da empresa não encontrada (company_fiscal_settings).', 422)
  if (!settings.nfce_enabled) return failure('Emissão de NFC-e não habilitada (company_fiscal_settings.nfce_enabled=false).', 422)
  if (settings.nfce_environment !== 'homologacao') {
    return failure('Bloqueado: esta rota só emite em homologação. company_fiscal_settings.nfce_environment não é "homologacao".', 403)
  }

  const providerRef = buildProviderRef(companyId, saleId, 'nfce')

  // ─── Claim atômico curto — decide ANTES de qualquer HTTP ────────────────
  const claim = await claimFiscalEmission(admin, companyId, saleId, providerRef, 'homologacao', 'nfce')

  if (claim.decision === 'already_authorized' || claim.decision === 'already_cancelled') {
    return success(rowToResult(claim.row))
  }

  if (claim.decision === 'busy') {
    return success(rowToResult({
      ...claim.row,
      status: 'pending',
      status_message: `Outra tentativa de emissão está em andamento para esta venda (lease até ${claim.leaseUntil}) — tente novamente em instantes.`,
    }))
  }

  if (claim.decision === 'reconciliation_required') {
    return consultAndUpdateNfceDocument(claim.row.id, claim.row.provider_ref, companyId)
  }

  // ─── claim.decision === 'claimed' ────────────────────────────────────────
  const fiscalDocumentId = claim.row.id
  const claimToken = claim.claimToken
  if (!claimToken) throw new Error('rpc_claim_fiscal_emission devolveu decision=claimed sem claim_token — inconsistência inesperada.')

  // ─── Resolve integração/token (mesma integração Focus de NF-e — token único por empresa) ──
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
  // operationOverrides fixos: NFC-e só é usada (via resolveFiscalDocumentType)
  // pra venda pickup presencial, nunca entrega/site — presencaComprador=1
  // (presencial) e modalidadeFrete=9 (sem frete, retirada não tem
  // transporte) refletem isso, em vez do default do contexto (pensado pra
  // NF-e/ecommerce: presencaComprador=2).
  let context
  try {
    context = await loadSaleFiscalContext({
      saleId, companyId, providerRef, environment: 'homologacao',
      operationOverrides: { presencaComprador: 1, modalidadeFrete: 9 },
    })
  } catch (err) {
    if (err instanceof FiscalContextError) return failure(err.message, 404)
    throw err
  }

  const validationErrors = validateNfceReadiness(context)
  if (validationErrors.length > 0) {
    const updated = await completeFiscalEmission(admin, {
      fiscalDocumentId,
      claimToken,
      status: 'validation_failed',
      fiscalContextSnapshot: context,
      submissionErrorCode: 'local_validation_failed',
      submissionErrorMessage: validationErrors.map((e) => e.message).join('; '),
    })
    if (!updated) return success(rowToResult(await fetchCurrentFiscalDocumentRow(admin, fiscalDocumentId), validationErrors))
    return success(rowToResult(updated, validationErrors))
  }

  // ─── Monta payload + snapshot ────────────────────────────────────────────
  let payload
  let snapshot
  try {
    payload = buildNfcePayload(context)
    snapshot = buildNfceDocumentSnapshot(context)
  } catch (err) {
    const message = err instanceof FiscalRuleNotImplementedError || err instanceof FiscalBuildError
      ? err.message
      : 'Falha inesperada ao montar o payload.'
    const updated = await completeFiscalEmission(admin, {
      fiscalDocumentId,
      claimToken,
      status: 'validation_failed',
      fiscalContextSnapshot: context,
      submissionErrorCode: 'local_build_failed',
      submissionErrorMessage: message,
    })
    if (!updated) return success(rowToResult(await fetchCurrentFiscalDocumentRow(admin, fiscalDocumentId), [{ code: 'local_build_failed', message }]))
    return success(rowToResult(updated, [{ code: 'local_build_failed', message }]))
  }

  // ─── Marca início de transmissão ANTES de transmitir — mesma infra de
  // claim/lease/begin de NF-e, zero mudança de lógica. ──────────────────────
  const beginRow = await beginFiscalTransmission(admin, {
    fiscalDocumentId,
    claimToken,
    requestPayload: payload,
    fiscalContextSnapshot: context,
  })
  if (!beginRow) {
    return success(rowToResult(await fetchCurrentFiscalDocumentRow(admin, fiscalDocumentId)))
  }

  await (admin as any).from('fiscal_document_items').delete().eq('fiscal_document_id', fiscalDocumentId)
  if (snapshot.items.length > 0) {
    await (admin as any).from('fiscal_document_items').insert(
      snapshot.items.map((item) => ({ ...item, fiscal_document_id: fiscalDocumentId, company_id: companyId })),
    )
  }

  // ─── Transmite — fora de qualquer transação, nenhum lock/claim mantido
  // durante o HTTP. NFC-e é SÍNCRONA (autorizado/erro_autorizacao já vêm
  // nesta mesma resposta) — mas o tratamento de timeout/rede continua
  // idêntico ao de NF-e (resultado GENUINAMENTE desconhecido → pending). ──
  try {
    const response = await issueFocusNfce(providerRef, payload, { token, environment })
    const status = mapFocusNfceStatus(response.status)
    // Extraída ANTES de chamar completeFiscalEmission — se malformada,
    // lança aqui (FocusAccessKeyError) e cai no catch abaixo, que marca
    // 'pending' com uma mensagem diagnóstica CLARA (nunca o erro genérico
    // do Postgres "value too long...") e preserva submission_started_at,
    // forçando reconciliação na próxima tentativa — mesmo mecanismo de
    // segurança já usado pra timeout/rede.
    const accessKey = status === 'authorized' ? extractFocusAccessKey(response.chave_nfe) : null

    const updated = await completeFiscalEmission(admin, {
      fiscalDocumentId,
      claimToken,
      status,
      providerPayload: response,
      statusSefaz: response.status_sefaz != null ? String(response.status_sefaz) : null,
      statusMessage: response.mensagem_sefaz ?? null,
      ...(status === 'authorized' ? {
        number: response.numero ?? null,
        series: response.serie ?? null,
        accessKey,
        // Débito técnico fechado (achado da auditoria da venda 626, item
        // 1): `numero_protocolo` é FLAT na resposta de NFC-e — ver mesma
        // nota em applyFocusNfceResponse.
        authorizationProtocol: response.numero_protocolo ?? null,
        xmlPath: response.caminho_xml_nota_fiscal ?? null,
        danfePath: response.caminho_danfe ?? null,
        authorizedAt: new Date().toISOString(),
      } : {}),
    })

    if (!updated) return success(rowToResult(await fetchCurrentFiscalDocumentRow(admin, fiscalDocumentId)))
    return success(rowToResult(updated))
  } catch (err) {
    if (err instanceof FocusApiError) {
      const updated = await completeFiscalEmission(admin, {
        fiscalDocumentId,
        claimToken,
        status: 'submission_error',
        submissionErrorCode: err.codigo ?? String(err.httpStatus),
        submissionErrorMessage: err.mensagem ?? err.message,
      })
      if (!updated) return success(rowToResult(await fetchCurrentFiscalDocumentRow(admin, fiscalDocumentId)))
      return success(rowToResult(updated))
    }

    const message = err instanceof Error ? err.message : 'Erro desconhecido ao transmitir.'
    const updated = await completeFiscalEmission(admin, {
      fiscalDocumentId,
      claimToken,
      status: 'pending',
      statusMessage: `Resultado desconhecido após falha de transmissão: ${message}`,
    })
    if (!updated) return success(rowToResult(await fetchCurrentFiscalDocumentRow(admin, fiscalDocumentId)))
    return success(rowToResult(updated))
  }
}
