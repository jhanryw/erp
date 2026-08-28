/**
 * Transmission service — Fase Fiscal 2B (base) + Fase Fiscal 3B (lock de
 * concorrência).
 *
 * `submitNfeHomologacao(saleId, companyId)` é o ÚNICO ponto do projeto que
 * chama `POST /v2/nfe` (emissão real). Só em homologação — bloqueia
 * produção explicitamente antes de qualquer outra coisa. Nunca chamado
 * automaticamente (sem outbox/sale.completed nesta fase) — só via
 * `POST /api/fiscal/nfe/emitir-homologacao`, acionado manualmente por um
 * admin.
 *
 * ─── Concorrência (Fase Fiscal 3B) ───────────────────────────────────────
 *
 * Risco anterior (corrigido nesta fase, ver
 * docs/fiscal-fase3b-concorrencia-claim-lease.md pro relatório completo):
 * a versão anterior deste arquivo buscava/criava a linha de
 * `fiscal_documents` e só DEPOIS checava o status — sem nenhum lock real,
 * duas execuções concorrentes (duplo clique, dois containers, retry) para
 * a MESMA venda passavam pelas mesmas checagens e podiam AMBAS chegar ao
 * `issueFocusNfe`. O `UNIQUE(provider, provider_ref)` só protegia o
 * INSERT da linha, nunca duas transmissões concorrentes sobre uma linha
 * já existente.
 *
 * Desenho novo: `rpc_claim_fiscal_emission` (claim atômico curto,
 * `SELECT ... FOR UPDATE` só dentro da própria função — nunca ao redor de
 * HTTP) decide entre `claimed`/`busy`/`already_authorized`/
 * `already_cancelled`/`reconciliation_required` ANTES de qualquer chamada
 * à Focus. Só depois de `claimed` (com um `claim_token` imprevisível e
 * uma lease de 60s) o service prossegue pra HTTP, fora de qualquer
 * transação. Toda escrita de resultado depois do claim passa por
 * `rpc_complete_fiscal_emission`, que só afeta a linha se
 * `submission_claim_token` ainda for o mesmo — protege contra um worker
 * antigo (lease expirada, outro claim já concedido) sobrescrever o
 * resultado de um claim mais novo (seção 10 do pedido da fase).
 *
 * Lease expirada NUNCA autoriza retransmissão direta — só ativa reclamar
 * de novo; se o status ainda for `pending`, a única decisão possível é
 * `reconciliation_required` (consultar a Focus pela MESMA ref antes de
 * qualquer outra coisa).
 *
 * ─── Fechamento do risco residual #2 (mesma fase) ────────────────────────
 *
 * Risco: se `issueFocusNfe` demorar mais que a lease (ex.: a Focus recebeu
 * a requisição e está processando, mas nosso próprio timeout de cliente
 * já estourou, ou o processo morre depois de disparar o POST), uma
 * segunda execução podia reclamar o documento, consultar a Focus, receber
 * um "não encontrado" AMBÍGUO (a Focus pode não ter processado a
 * transmissão original ainda) e concluir erradamente que era seguro
 * reemitir — abrindo a porta pra duas transmissões HTTP concorrentes com
 * a mesma `provider_ref`.
 *
 * Fechado distinguindo três estados explícitos: claim adquirido →
 * transmissão iniciada → resultado/reconciliação. `rpc_begin_fiscal_
 * transmission` marca atomicamente `submission_started_at`, guardada pelo
 * `claim_token` vigente, IMEDIATAMENTE ANTES de `issueFocusNfe`. A partir
 * daí, `rpc_claim_fiscal_emission` NUNCA mais concede um claim direto
 * enquanto essa marca existir — sempre devolve `reconciliation_required`,
 * incondicionalmente, mesmo com a lease expirada. Só uma nova
 * `already_authorized`/consulta que confirme inequivocamente a ausência
 * da `provider_ref` na Focus (ou nenhuma evidência de transmissão ter
 * ocorrido) libera uma nova tentativa — sempre com a MESMA `provider_ref`.
 * Não resolvido aumentando a lease — a decisão passou a ser independente
 * da duração da lease a partir do momento em que existe evidência de
 * despacho real.
 *
 * ─── Idempotência (herdada da Fase 2B, preservada) ──────────────────────
 *
 * `provider_ref` continua DETERMINÍSTICA — `qarvon-{company_id}-{sale_id}
 * -nfe` (`buildProviderRef`) — nunca um UUID por tentativa, nunca
 * `-attempt-N`/`-retry-N`. `UNIQUE(provider, provider_ref)`,
 * `UNIQUE(access_key) WHERE NOT NULL` e `UNIQUE(sale_id, document_type)
 * WHERE status='authorized'` continuam intocadas — o claim COMPLEMENTA
 * essas barreiras, nunca as substitui.
 *
 * ─── Máquina de estados (herdada da Fase 2B) ─────────────────────────────
 *
 * `erro_autorizacao` da Focus NUNCA é tratado como suficiente sozinho —
 * `status_sefaz`/`mensagem_sefaz` são sempre persistidos junto. Erro
 * síncrono da Focus (400/422, a chamada nem chegou na SEFAZ) vira
 * `submission_error` — nunca confundido com `authorization_failed`.
 * Timeout/rede (resultado GENUINAMENTE desconhecido) vira `pending` —
 * nunca `submission_error`, nunca um POST automático de novo.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/errors/log'
import { resolveFocusIntegration } from './resolveFocusIntegration'
import { loadSaleFiscalContext, FiscalContextError } from './loadSaleFiscalContext'
import { validateNfeReadiness } from './validateFiscalReadiness'
import { buildNfePayload, FiscalBuildError } from './buildNfePayload'
import { FiscalRuleNotImplementedError } from '@/lib/fiscal/taxRules'
import { buildFiscalDocumentSnapshot } from './buildFiscalSnapshot'
import { issueFocusNfe, consultFocusNfe } from '@/lib/integrations/focus/httpClient'
import { FocusApiError, type FocusNfeConsultaResponse, type FocusEnvironment } from '@/lib/integrations/focus/types'
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
  /** Conteúdo real do QR Code fiscal (só NFC-e — Focus não retorna pra NF-e, fica `null`). */
  qrcodeUrl: string | null
  /** Ambiente REAL do documento (`fiscal_documents.environment`) — nunca inferido do host do danfe_path/token/config atual. Ver comentário completo em `FiscalDocumentRow.environment`. */
  environment: FocusEnvironment
  validationErrors: FiscalValidationError[]
}

// ─── Exportado pra reaproveitamento por submitNfceHomologacao.ts (Fase 4E)
// — visibilidade apenas, ZERO mudança de lógica/comportamento nestas
// definições. Infraestrutura de transmissão (claim/begin/complete) é
// agnóstica ao tipo de documento desde a parametrização de document_type
// (Fase 4B). ─────────────────────────────────────────────────────────────
export interface FiscalDocumentRow {
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
  qrcode_url: string | null
  /**
   * Ambiente REAL do documento (`fiscal_documents.environment`) — a
   * identidade do próprio documento, nunca uma suposição/config atual.
   * `rpc_claim_fiscal_emission`/`rpc_complete_fiscal_emission` não
   * devolvem essa coluna no `RETURNS TABLE` (auditado — ver
   * `claimFiscalEmission`/`completeFiscalEmission` abaixo pra como cada
   * um preenche isto sem precisar de migration): o wrapper de claim já
   * RECEBE `environment` como parâmetro (usado no INSERT) e o injeta
   * de volta aqui; o wrapper de complete recebe via
   * `CompleteFiscalEmissionInput.environment` (o chamador já sabe esse
   * valor — é o mesmo usado pra montar `provider_ref`/claim) e injeta no
   * retorno da RPC. Leituras diretas (`fetchCurrentFiscalDocumentRow`,
   * `FISCAL_DOCUMENT_SELECT`) pegam o valor real persistido, sem
   * intermediário nenhum.
   */
  environment: FocusEnvironment
}

/** Lease do claim de transmissão — generosa o bastante pra cobrir carregar contexto + montar payload + o timeout HTTP da Focus (15s, ver httpClient.ts) com folga, curta o bastante pra um crash se autorrecuperar em ~1 minuto. */
export const FISCAL_EMISSION_LEASE_SECONDS = 60

export type FiscalClaimDecision = 'claimed' | 'busy' | 'already_authorized' | 'already_cancelled' | 'reconciliation_required'

export interface FiscalClaimResult {
  decision: FiscalClaimDecision
  row: FiscalDocumentRow
  claimToken: string | null
  leaseUntil: string | null
}

/**
 * Determinístico — nunca um UUID aleatório, nunca `-attempt-N`/`-retry-N`.
 * Ver comentário do arquivo. `documentType` no sufixo (Fase Fiscal 4):
 * uma mesma venda pode ter uma tentativa de NF-e E uma de NFC-e como
 * linhas `fiscal_documents` SEPARADAS (cada uma com seu próprio
 * `provider_ref`, nunca a mesma) — `UNIQUE(provider, provider_ref)` é
 * global por provider, então uma ref compartilhada entre os dois tipos
 * colidiria ou misturaria claim/lease de tentativas diferentes.
 *
 * `environment` no sufixo (fundação homologação↔produção, sessão de
 * auditoria "mesma venda, dois ambientes"): pela MESMA razão do
 * `documentType` acima — homologação e produção da mesma venda+tipo
 * viram linhas SEPARADAS (cada uma com seu próprio claim/lease), nunca
 * podem compartilhar `provider_ref` sob pena de colidir em
 * `UNIQUE(provider, provider_ref)` ou de uma reclamar a linha da outra.
 * `environment` é OBRIGATÓRIO (sem default) — nunca comportamento
 * implícito sobre qual ambiente está sendo referenciado. Refs HISTÓRICAS
 * (formato antigo, sem sufixo de ambiente) continuam válidas e nunca são
 * reescritas — este é só o formato para NOVAS linhas a partir de agora
 * (ver migration da fundação homologação/produção).
 */
export function buildProviderRef(companyId: number, saleId: number, environment: FocusEnvironment, documentType: 'nfe' | 'nfce' = 'nfe'): string {
  return `qarvon-${companyId}-${saleId}-${documentType}-${environment}`
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

export function rowToResult(row: FiscalDocumentRow, validationErrors: FiscalValidationError[] = []): SubmitNfeResult {
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
    qrcodeUrl: row.qrcode_url,
    environment: row.environment,
    validationErrors,
  }
}

export const FISCAL_DOCUMENT_SELECT = 'id, status, provider_ref, number, series, access_key, authorization_protocol, status_sefaz, status_message, submission_error_code, submission_error_message, xml_path, danfe_path, qrcode_url, environment'

/**
 * Wrapper de `rpc_claim_fiscal_emission` — claim atômico curto, comita
 * antes de qualquer HTTP (a chamada `.rpc()` em si já é uma transação
 * fechada). Nunca chamado de dentro de outra transação.
 */
export async function claimFiscalEmission(
  admin: ReturnType<typeof createAdminClient>,
  companyId: number,
  saleId: number,
  providerRef: string,
  environment: FocusEnvironment,
  documentType: 'nfe' | 'nfce' = 'nfe',
): Promise<FiscalClaimResult> {
  const { data, error } = await (admin as any).rpc('rpc_claim_fiscal_emission', {
    p_company_id: companyId,
    p_sale_id: saleId,
    p_provider_ref: providerRef,
    p_environment: environment,
    p_lease_seconds: FISCAL_EMISSION_LEASE_SECONDS,
    p_document_type: documentType,
  })

  if (error) throw new Error(`Falha ao reivindicar emissão fiscal pra venda ${saleId}: ${error.message}`)
  const row = ((data as any[]) ?? [])[0]
  if (!row) throw new Error(`rpc_claim_fiscal_emission não devolveu nenhuma linha pra venda ${saleId}.`)

  return {
    decision: row.decision as FiscalClaimDecision,
    row: {
      id: row.id,
      status: row.status,
      provider_ref: row.provider_ref,
      number: row.number,
      series: row.series,
      access_key: row.access_key,
      authorization_protocol: row.authorization_protocol,
      status_sefaz: row.status_sefaz,
      status_message: row.status_message,
      submission_error_code: row.submission_error_code,
      submission_error_message: row.submission_error_message,
      xml_path: row.xml_path,
      danfe_path: row.danfe_path,
      // `rpc_claim_fiscal_emission` roda ANTES da transmissão (draft/pending)
      // — qrcode_url só existe depois de autorizada, nunca neste ponto do
      // fluxo. RPC não precisa devolver a coluna; `null` aqui é sempre correto.
      qrcode_url: row.qrcode_url ?? null,
      // `rpc_claim_fiscal_emission` não devolve `environment` no
      // RETURNS TABLE (auditado) — mas o PARÂMETRO `environment` desta
      // função É a identidade real do documento (o mesmo valor gravado no
      // INSERT da RPC, `p_environment`), nunca uma suposição. Sem
      // migration: menor superfície correta.
      environment,
    },
    claimToken: row.submission_claim_token ?? null,
    leaseUntil: row.submission_lease_until ?? null,
  }
}

export interface CompleteFiscalEmissionInput {
  fiscalDocumentId: number
  claimToken: string
  /**
   * Ambiente REAL deste documento — o MESMO valor já usado pelo chamador
   * pra montar `provider_ref`/o claim (`configuredEnvironment`/
   * `environment` de `resolveFocusIntegration`), nunca um literal novo.
   * Obrigatório, sem default: `rpc_complete_fiscal_emission` não devolve
   * `environment` no `RETURNS TABLE` (auditado), então este wrapper
   * precisa injetar o valor de volta no resultado — só pode fazer isso
   * corretamente se o chamador entregar o valor real que já tinha em mãos.
   */
  environment: FocusEnvironment
  status: FiscalDocumentDomainStatus
  statusSefaz?: string | null
  statusMessage?: string | null
  submissionErrorCode?: string | null
  submissionErrorMessage?: string | null
  number?: string | null
  series?: string | null
  accessKey?: string | null
  authorizationProtocol?: string | null
  xmlPath?: string | null
  danfePath?: string | null
  providerPayload?: unknown
  requestPayload?: unknown
  fiscalContextSnapshot?: unknown
  issuedAt?: string
  authorizedAt?: string
}

/**
 * Wrapper de `rpc_complete_fiscal_emission` — só afeta a linha se
 * `claimToken` ainda for o vigente. `null` = token superado (outro claim
 * já assumiu) — quem chama NUNCA deve tratar isso como erro, só como "meu
 * resultado não é mais o que vale, busque o atual".
 */
export async function completeFiscalEmission(
  admin: ReturnType<typeof createAdminClient>,
  input: CompleteFiscalEmissionInput,
): Promise<FiscalDocumentRow | null> {
  const { data, error } = await (admin as any).rpc('rpc_complete_fiscal_emission', {
    p_fiscal_document_id: input.fiscalDocumentId,
    p_claim_token: input.claimToken,
    p_status: input.status,
    p_status_sefaz: input.statusSefaz ?? null,
    p_status_message: input.statusMessage ?? null,
    p_submission_error_code: input.submissionErrorCode ?? null,
    p_submission_error_message: input.submissionErrorMessage ?? null,
    p_number: input.number ?? null,
    p_series: input.series ?? null,
    p_access_key: input.accessKey ?? null,
    p_authorization_protocol: input.authorizationProtocol ?? null,
    p_xml_path: input.xmlPath ?? null,
    p_danfe_path: input.danfePath ?? null,
    p_provider_payload: input.providerPayload ?? null,
    p_request_payload: input.requestPayload ?? null,
    p_fiscal_context_snapshot: input.fiscalContextSnapshot ?? null,
    p_issued_at: input.issuedAt ?? null,
    p_authorized_at: input.authorizedAt ?? null,
  })

  if (error) throw new Error(`Falha ao concluir emissão fiscal (documento ${input.fiscalDocumentId}): ${error.message}`)
  const rows = (data as any[]) ?? []
  // `rpc_complete_fiscal_emission` não devolve `environment` (auditado) —
  // injeta o valor real que o CHAMADOR já tinha (`input.environment`),
  // nunca um literal/suposição. Sem migration: menor superfície correta.
  return rows[0] ? ({ ...rows[0], environment: input.environment } as FiscalDocumentRow) : null
}

export interface BeginFiscalTransmissionInput {
  fiscalDocumentId: number
  claimToken: string
  requestPayload: unknown
  fiscalContextSnapshot: unknown
}

/**
 * Wrapper de `rpc_begin_fiscal_transmission` — fechamento do risco
 * residual #2. Chamada IMEDIATAMENTE ANTES de `issueFocusNfe`, guardada
 * pelo `claimToken` vigente. `null` = claim já superado (outra execução
 * assumiu enquanto validávamos/montávamos o payload) — quem chama NUNCA
 * deve prosseguir pro POST nesse caso.
 */
export async function beginFiscalTransmission(
  admin: ReturnType<typeof createAdminClient>,
  input: BeginFiscalTransmissionInput,
): Promise<FiscalDocumentRow | null> {
  const { data, error } = await (admin as any).rpc('rpc_begin_fiscal_transmission', {
    p_fiscal_document_id: input.fiscalDocumentId,
    p_claim_token: input.claimToken,
    p_request_payload: input.requestPayload ?? null,
    p_fiscal_context_snapshot: input.fiscalContextSnapshot ?? null,
  })

  if (error) throw new Error(`Falha ao marcar início de transmissão fiscal (documento ${input.fiscalDocumentId}): ${error.message}`)
  const rows = (data as any[]) ?? []
  return rows[0] ? (rows[0] as FiscalDocumentRow) : null
}

/** Leitura simples, sem guard de token — usada só quando um `completeFiscalEmission` foi recusado (token superado) e precisamos devolver o estado ATUAL e real pro chamador original. */
export async function fetchCurrentFiscalDocumentRow(admin: ReturnType<typeof createAdminClient>, fiscalDocumentId: number): Promise<FiscalDocumentRow> {
  const { data } = await (admin as any).from('fiscal_documents').select(FISCAL_DOCUMENT_SELECT).eq('id', fiscalDocumentId).single()
  return data as FiscalDocumentRow
}

async function applyFocusResponse(
  admin: ReturnType<typeof createAdminClient>,
  fiscalDocumentId: number,
  response: FocusNfeConsultaResponse,
  providerRef: string,
): Promise<FiscalDocumentDomainStatus> {
  const domainStatus = mapFocusStatus(response.status)

  // Mesmo achado/correção aplicado em NFC-e (venda 703, homologação,
  // 2026-08-28, ver comentário completo em
  // submitNfceHomologacao.ts:applyFocusNfceResponse) — esta função também
  // reconcilia documentos JÁ authorized ("Verificar status"), não só
  // confirma pending. Uma consulta nunca pode degradar dado local já
  // confiável só porque a resposta desta consulta específica omitiu o
  // campo. Lê o estado atual ANTES de decidir o que persistir.
  const { data: currentRaw } = await (admin as any)
    .from('fiscal_documents')
    .select('status, authorized_at, authorization_protocol, access_key, number, series, xml_path, danfe_path, sale_id, company_id, document_type, environment')
    .eq('id', fiscalDocumentId)
    .maybeSingle()
  const current = (currentRaw ?? {}) as Record<string, unknown>

  const patch: Record<string, unknown> = {
    status: domainStatus,
    // `provider_payload` é a ÚLTIMA resposta bruta recebida da Focus pra
    // este documento, não um histórico imutável — ver mesma nota em
    // submitNfceHomologacao.ts:applyFocusNfceResponse.
    provider_payload: response,
    status_sefaz: response.status_sefaz != null ? String(response.status_sefaz) : null,
    status_message: response.mensagem_sefaz ?? null,
  }

  // Fechamento do risco residual #2: enquanto o resultado ainda é 'pending'
  // (Focus respondeu 'processando_autorizacao' — a transmissão original
  // genuinamente existe e ainda não terminou), NÃO limpa
  // submission_started_at — a incerteza continua, o próximo claim ainda
  // deve forçar reconciliação. Qualquer outro resultado aqui é uma
  // conclusão DEFINITIVA da Focus (autorizado/rejeitado/cancelado/erro de
  // cancelamento) — a incerteza que submission_started_at representava foi
  // resolvida, então ela é liberada, permitindo que um claim futuro (se
  // ainda fizer sentido pro novo status) seja concedido direto, sem exigir
  // outra reconciliação desnecessária.
  if (domainStatus !== 'pending') {
    patch.submission_started_at = null
  }

  if (domainStatus === 'authorized') {
    // Campo confiável presente NESTA resposta → atualiza. Ausente →
    // preserva o valor local já existente (nunca apaga um dado bom só
    // porque esta consulta específica omitiu o campo). `access_key` aqui
    // nunca passou por `extractFocusAccessKey` (débito técnico separado,
    // pré-existente, fora de escopo — ver nota em
    // submitNfceHomologacao.ts:extractFocusAccessKey) — preserva o mesmo
    // comportamento permissivo já existente, só evita apagar com null.
    patch.number = response.numero ?? current.number ?? null
    patch.series = response.serie ?? current.series ?? null
    patch.access_key = response.chave_nfe ?? current.access_key ?? null
    patch.authorization_protocol = response.protocolo_nota_fiscal?.numero_protocolo ?? (current.authorization_protocol as string | null | undefined) ?? null
    patch.xml_path = response.caminho_xml_nota_fiscal ?? current.xml_path ?? null
    patch.danfe_path = response.caminho_danfe ?? current.danfe_path ?? null
    // `authorized_at` é a data do EVENTO de autorização, não da consulta —
    // ver mesma nota em submitNfceHomologacao.ts:applyFocusNfceResponse.
    patch.authorized_at = (current.status === 'authorized' && current.authorized_at)
      ? current.authorized_at
      : new Date().toISOString()

    if (!patch.authorization_protocol) {
      logError({
        route: 'consultAndUpdateFiscalDocument (authorization_protocol ausente)',
        err: new Error('authorized fiscal document missing local authorization protocol — Focus confirmou NF-e autorizada, mas nenhuma resposta (esta consulta ou uma anterior) trouxe protocolo_nota_fiscal.numero_protocolo.'),
        context: {
          fiscal_document_id: fiscalDocumentId,
          company_id: current.company_id ?? null,
          sale_id: current.sale_id ?? null,
          document_type: current.document_type ?? 'nfe',
          environment: current.environment ?? null,
          provider_ref: providerRef,
          access_key: patch.access_key ?? null,
        },
      })
    }
  }

  // Mesmo padrão já adotado em NFC-e (achado real, venda 626, item 7 da
  // auditoria — ver applyFocusNfceResponse): esta chamada nunca checava
  // `error` — uma falha de escrita era engolida em silêncio, e a função
  // devolvia `domainStatus` (ex.: 'authorized') mesmo que NADA tivesse
  // sido gravado. Qualquer erro de escrita agora propaga (lança), nunca é
  // engolido — o chamador (`consultAndUpdateFiscalDocument`) cai no
  // branch de erro e NUNCA afirma um status que não foi persistido.
  const { error: updateError } = await (admin as any).from('fiscal_documents').update(patch).eq('id', fiscalDocumentId)
  if (updateError) {
    const context = domainStatus === 'authorized'
      ? 'Focus confirmou autorização, mas a gravação no banco falhou — NUNCA considere esta NF-e autorizada até uma reconciliação confirmar o estado real persistido.'
      : `Falha ao persistir status fiscal (documento ${fiscalDocumentId}).`
    throw new Error(`${context} Causa: ${updateError.message}`)
  }

  return domainStatus
}

/**
 * Consulta a Focus pela ref existente e atualiza a linha — nunca chama
 * `POST /v2/nfe` aqui. Usado quando o claim devolve
 * `reconciliation_required` e por `consultNfeStatus.ts` (polling manual
 * explícito).
 *
 * Escreve SEM exigir `claim_token` — de propósito: é leitura da verdade
 * da Focus, determinística por `ref`. Mesmo que uma execução "antiga"
 * grave o resultado de uma consulta, é a MESMA verdade que qualquer outra
 * consulta chegaria — não há "worker errado sobrescrevendo", só "verdade
 * confirmada de novo". O guard de token (`rpc_complete_fiscal_emission`)
 * existe pra proteger o resultado de um `POST`, que pode variar por
 * tentativa — não pra uma consulta idempotente.
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
    const status = await applyFocusResponse(admin, fiscalDocumentId, response, providerRef)

    const { data: row } = await (admin as any)
      .from('fiscal_documents')
      .select(FISCAL_DOCUMENT_SELECT)
      .eq('id', fiscalDocumentId)
      .single()

    return success(rowToResult({ ...(row as FiscalDocumentRow), status }))
  } catch (err) {
    // Cenário A de recuperação de crash (seção 9 do pedido da Fase 3B):
    // "processo morre antes do POST → lease expira → consulta Focus pela
    // ref → INEXISTENTE → só então nova transmissão pode ser considerada."
    // A Focus confirma "não encontrado" (404, codigo='nao_encontrado') —
    // significa que a Focus NUNCA recebeu essa ref, então fica seguro
    // liberar o documento pra uma tentativa real (`submission_error` é o
    // status "retentável" correto aqui, mesmo significado de "a SEFAZ
    // nunca viu isso"). Qualquer OUTRO erro de consulta (rede, 500, etc.)
    // continua sem tocar a linha — resultado genuinamente desconhecido,
    // não vira uma permissão de retry.
    if (err instanceof FocusApiError && (err.httpStatus === 404 || err.codigo === 'nao_encontrado')) {
      await (admin as any).from('fiscal_documents').update({
        status: 'submission_error',
        submission_error_code: err.codigo ?? '404',
        submission_error_message: 'Focus confirmou que esta referência nunca foi recebida — seguro tentar uma nova transmissão.',
        // Fechamento do risco residual #2: a Focus confirmou INEQUIVOCAMENTE
        // a ausência da provider_ref (caso 2 do pedido) — a incerteza que
        // submission_started_at representava foi resolvida, libera pra um
        // claim futuro poder ser concedido direto (mesma provider_ref,
        // nunca uma nova). Sem isto, submission_started_at continuaria
        // setado pra sempre e TODO claim futuro cairia em
        // reconciliation_required de novo, mesmo já sabendo que é seguro
        // reclamar — um laço sem saída.
        submission_started_at: null,
      }).eq('id', fiscalDocumentId)

      const { data: row } = await (admin as any)
        .from('fiscal_documents')
        .select(FISCAL_DOCUMENT_SELECT)
        .eq('id', fiscalDocumentId)
        .single()

      return success(rowToResult(row as FiscalDocumentRow))
    }

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

  // `settings.nfe_environment` (não um literal 'homologacao' hardcoded) —
  // já confirmado === 'homologacao' pelo gate acima nesta fase, mas usar a
  // variável real (em vez do literal) significa que este call site não
  // precisa de outra edição no dia em que o gate acima for removido numa
  // fase futura de produção. Nome `configuredEnvironment` (não
  // `environment`) pra não colidir com o `environment` resolvido mais
  // abaixo a partir de `resolveFocusIntegration` (mesmo valor esperado
  // hoje, fontes conceitualmente distintas).
  const configuredEnvironment = settings.nfe_environment as FocusEnvironment
  const providerRef = buildProviderRef(companyId, saleId, configuredEnvironment, 'nfe')

  // ─── Claim atômico curto — decide ANTES de qualquer HTTP ────────────────
  const claim = await claimFiscalEmission(admin, companyId, saleId, providerRef, configuredEnvironment, 'nfe')

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
    // Lease livre/expirada, mas resultado da tentativa anterior é
    // desconhecido — nunca reclama nem reemite direto (seção 7 do pedido:
    // "lease expirou ≠ POST novamente"). Consulta a Focus primeiro.
    return consultAndUpdateFiscalDocument(claim.row.id, claim.row.provider_ref, companyId)
  }

  // ─── claim.decision === 'claimed' ────────────────────────────────────────
  const fiscalDocumentId = claim.row.id
  const claimToken = claim.claimToken
  if (!claimToken) throw new Error('rpc_claim_fiscal_emission devolveu decision=claimed sem claim_token — inconsistência inesperada.')

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

  const validationErrors = validateNfeReadiness(context)
  if (validationErrors.length > 0) {
    const updated = await completeFiscalEmission(admin, {
      fiscalDocumentId,
      claimToken,
      environment: configuredEnvironment,
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
    payload = buildNfePayload(context)
    snapshot = buildFiscalDocumentSnapshot(context)
  } catch (err) {
    // FiscalRuleNotImplementedError (ex.: CRT 2/3, método de pagamento sem
    // regra) capturado ANTES do fallback genérico — achado da auditoria da
    // Fase Fiscal 3: a mensagem real e específica nunca deve ser engolida
    // por "Falha inesperada ao montar o payload".
    const message = err instanceof FiscalRuleNotImplementedError || err instanceof FiscalBuildError
      ? err.message
      : 'Falha inesperada ao montar o payload.'
    const updated = await completeFiscalEmission(admin, {
      fiscalDocumentId,
      claimToken,
      environment: configuredEnvironment,
      status: 'validation_failed',
      fiscalContextSnapshot: context,
      submissionErrorCode: 'local_build_failed',
      submissionErrorMessage: message,
    })
    if (!updated) return success(rowToResult(await fetchCurrentFiscalDocumentRow(admin, fiscalDocumentId), [{ code: 'local_build_failed', message }]))
    return success(rowToResult(updated, [{ code: 'local_build_failed', message }]))
  }

  // ─── Marca início de transmissão ANTES de transmitir (fechamento do
  // risco residual #2) — guardado pelo MESMO claim_token E exige lease
  // AINDA ativa neste exato instante (`rpc_begin_fiscal_transmission`
  // exige id + claim_token + submission_lease_until > NOW() +
  // submission_started_at IS NULL). `beginFiscalTransmission` devolve null
  // por QUALQUER um desses três motivos (token superado por outra
  // execução, lease vencida — inclusive se ESTE worker simplesmente
  // demorou demais entre o claim e este ponto — ou begin já chamado antes
  // sob este mesmo token) e em TODOS os casos NUNCA prosseguimos pro POST
  // — fecha a janela de corrida bem antes da chamada HTTP, não só depois
  // dela. Deliberadamente NÃO usa `completeFiscalEmission` aqui: aquela
  // chamada SEMPRE libera a lease ao retornar (ver migration), o que
  // zeraria a proteção da lease durante a janela do POST em si —
  // `rpc_begin_fiscal_transmission` não toca a lease, só marca
  // `submission_started_at`. ──────────────────────────────────────────────
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
  // durante o HTTP ──────────────────────────────────────────────────────────
  try {
    const response = await issueFocusNfe(providerRef, payload, { token, environment })
    const status = mapFocusStatus(response.status)

    const updated = await completeFiscalEmission(admin, {
      fiscalDocumentId,
      claimToken,
      environment: configuredEnvironment,
      status,
      providerPayload: response,
      statusSefaz: response.status_sefaz != null ? String(response.status_sefaz) : null,
      statusMessage: response.mensagem_sefaz ?? null,
      ...(status === 'authorized' ? {
        number: response.numero ?? null,
        series: response.serie ?? null,
        accessKey: response.chave_nfe ?? null,
        authorizationProtocol: response.protocolo_nota_fiscal?.numero_protocolo ?? null,
        xmlPath: response.caminho_xml_nota_fiscal ?? null,
        danfePath: response.caminho_danfe ?? null,
        authorizedAt: new Date().toISOString(),
      } : {}),
    })

    if (!updated) return success(rowToResult(await fetchCurrentFiscalDocumentRow(admin, fiscalDocumentId)))
    return success(rowToResult(updated))
  } catch (err) {
    if (err instanceof FocusApiError) {
      // Erro síncrono — a SEFAZ nunca viu a tentativa. Nunca confundir com authorization_failed.
      const updated = await completeFiscalEmission(admin, {
        fiscalDocumentId,
        claimToken,
        environment: configuredEnvironment,
        status: 'submission_error',
        submissionErrorCode: err.codigo ?? String(err.httpStatus),
        submissionErrorMessage: err.mensagem ?? err.message,
      })
      if (!updated) return success(rowToResult(await fetchCurrentFiscalDocumentRow(admin, fiscalDocumentId)))
      return success(rowToResult(updated))
    }

    // Timeout/falha de rede — resultado GENUINAMENTE desconhecido. Fica
    // pending; a PRÓXIMA chamada (claim → reconciliation_required)
    // consulta antes de reemitir — nunca gera ref novo, nunca reemite às
    // cegas.
    const message = err instanceof Error ? err.message : 'Erro desconhecido ao transmitir.'
    const updated = await completeFiscalEmission(admin, {
      fiscalDocumentId,
      claimToken,
      environment: configuredEnvironment,
      status: 'pending',
      statusMessage: `Resultado desconhecido após falha de transmissão: ${message}`,
    })
    if (!updated) return success(rowToResult(await fetchCurrentFiscalDocumentRow(admin, fiscalDocumentId)))
    return success(rowToResult(updated))
  }
}
