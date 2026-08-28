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
import { logError } from '@/lib/errors/log'
import { resolveFocusIntegration } from './resolveFocusIntegration'
import { loadSaleFiscalContext, FiscalContextError } from './loadSaleFiscalContext'
import { validateNfceReadiness } from './validateFiscalReadiness'
import { buildNfcePayload } from './buildNfcePayload'
import { FiscalBuildError } from './buildNfePayload'
import { buildNfceDocumentSnapshot } from './buildFiscalSnapshot'
import { FiscalRuleNotImplementedError } from '@/lib/fiscal/taxRules'
import { issueFocusNfce, consultFocusNfce } from '@/lib/integrations/focus/httpClient'
import { FocusApiError, type FocusNfceConsultaResponse, type FocusEnvironment } from '@/lib/integrations/focus/types'
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

/**
 * Resolve `authorization_protocol` da resposta de NFC-e — ÚNICO ponto que
 * decide isso, usado tanto na emissão (`submitNfceHomologacao`) quanto na
 * reconciliação (`applyFocusNfceResponse`), pra nunca duplicar a lógica.
 *
 * ACHADO REAL (venda 703, homologação, 2026-08-28): o campo correto é
 * `protocolo`, PLANO no nível raiz da resposta — confirmado por
 * `provider_payload` de uma emissão real. `numero_protocolo` (o campo que
 * o código assumia antes, por analogia ao nome usado em NF-e) NUNCA foi
 * confirmado em nenhuma resposta real da Focus — ver comentário completo
 * em `FocusNfceConsultaResponse` (types.ts). Mantido só como fallback de
 * compatibilidade legada (fixtures/integrações antigas que possam ter
 * usado esse nome), sempre depois de `protocolo`.
 *
 * `existingProtocol` (opcional) é o valor JÁ persistido localmente — só
 * usado pela reconciliação, pra nunca degradar um protocolo já confiável
 * quando a resposta desta consulta específica (por qualquer motivo) vier
 * sem o campo. Na emissão (documento novo, sem valor local anterior) é
 * omitido.
 */
export function resolveNfceAuthorizationProtocol(
  response: FocusNfceConsultaResponse,
  existingProtocol?: string | null,
): string | null {
  return response.protocolo ?? response.numero_protocolo ?? existingProtocol ?? null
}

/**
 * Resolve `access_key` pra RECONCILIAÇÃO (nunca pra emissão nova — lá
 * `extractFocusAccessKey(response.chave_nfe)` continua direto, sem
 * fallback, porque uma emissão nova nunca tem valor local anterior pra
 * preservar). Uma consulta que confirma `autorizado` mas cuja resposta
 * (por qualquer motivo) venha sem `chave_nfe` NUNCA pode apagar uma
 * access_key já persistida — só lança quando não há resposta confiável
 * NEM valor local já existente (nada seguro pra persistir).
 */
function resolveAccessKeyForReconciliation(chaveNfe: string | null | undefined, existingAccessKey: string | null | undefined): string {
  if (chaveNfe) return extractFocusAccessKey(chaveNfe)
  if (existingAccessKey) return existingAccessKey
  throw new FocusAccessKeyError('Focus retornou status "autorizado" sem chave_nfe na resposta, e não há access_key local já persistida para preservar — não é seguro persistir a autorização sem a chave de acesso.')
}

async function applyFocusNfceResponse(
  admin: ReturnType<typeof createAdminClient>,
  fiscalDocumentId: number,
  response: FocusNfceConsultaResponse,
  providerRef: string,
): Promise<FiscalDocumentDomainStatus> {
  const domainStatus = mapFocusNfceStatus(response.status)

  // ACHADO REAL (venda 703, homologação, 2026-08-28): esta função é usada
  // TANTO pra confirmar um documento ainda pending QUANTO pra
  // reconciliar/"Verificar status" de um documento JÁ authorized — uma
  // consulta de status é informação NOVA se preencher algo que faltava,
  // mas NUNCA pode DEGRADAR um dado local já confiável só porque a
  // resposta desta consulta específica omitiu o campo (ex.: uma consulta
  // que não traga `protocolo` não pode apagar um `authorization_protocol`
  // já persistido de uma resposta anterior). Lê
  // o estado atual ANTES de decidir o que persistir.
  const { data: currentRaw } = await (admin as any)
    .from('fiscal_documents')
    .select('status, authorized_at, authorization_protocol, access_key, number, series, xml_path, danfe_path, qrcode_url, sale_id, company_id, document_type, environment')
    .eq('id', fiscalDocumentId)
    .maybeSingle()
  const current = (currentRaw ?? {}) as Record<string, unknown>

  const patch: Record<string, unknown> = {
    status: domainStatus,
    // `provider_payload` é a ÚLTIMA resposta bruta recebida da Focus pra
    // este documento, não um histórico imutável — cada reconciliação
    // substitui a anterior de propósito ("o que a Focus disse da última
    // vez que perguntamos", não um log de auditoria). Os campos fiscais
    // extraídos dela (abaixo) é que precisam de preservação individual —
    // o payload bruto em si não.
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
    // Campo confiável presente NESTA resposta → atualiza. Ausente →
    // preserva o valor local já existente (nunca apaga um dado bom só
    // porque esta consulta específica omitiu o campo).
    patch.number = response.numero ?? current.number ?? null
    patch.series = response.serie ?? current.series ?? null
    patch.access_key = resolveAccessKeyForReconciliation(response.chave_nfe, current.access_key as string | null | undefined)
    // CORRIGIDO (venda 703, evidência real de payload): o campo correto é
    // `protocolo`, não `numero_protocolo` — ver `resolveNfceAuthorizationProtocol`
    // e o comentário completo em `FocusNfceConsultaResponse` (types.ts).
    // Se nem `protocolo` nem o fallback legado vierem nesta resposta e não
    // houver valor local já confiável, permanece null (nunca fabrica
    // protocolo) — só o warning abaixo torna esse estado visível.
    patch.authorization_protocol = resolveNfceAuthorizationProtocol(response, current.authorization_protocol as string | null | undefined)
    patch.xml_path = response.caminho_xml_nota_fiscal ?? current.xml_path ?? null
    patch.danfe_path = response.caminho_danfe ?? current.danfe_path ?? null
    // `202609051000_fiscal_documents_qrcode_url.sql` — conteúdo real do QR
    // Code fiscal (URL de consulta com a chave/hash), nunca construído
    // localmente. Sem equivalente em NF-e (ver FocusNfceConsultaResponse).
    patch.qrcode_url = response.qrcode_url ?? current.qrcode_url ?? null
    // `authorized_at` é a data do EVENTO de autorização, não da consulta.
    // Uma reconciliação que confirma um documento JÁ authorized nunca
    // reescreve essa data — só preenche quando ainda não havia (primeira
    // vez que este documento passa a authorized via reconciliação).
    // `FocusNfceConsultaResponse` (ver types.ts) não tem nenhum campo de
    // data/hora da autorização — confirmado por leitura direta do tipo,
    // não uma omissão — então `new Date()` no momento da reconciliação é
    // a única fonte possível quando ainda não há valor local.
    patch.authorized_at = (current.status === 'authorized' && current.authorized_at)
      ? current.authorized_at
      : new Date().toISOString()

    if (!patch.authorization_protocol) {
      // Nunca vira exceção — mentiria sobre o estado fiscal real (a NFC-e
      // ESTÁ autorizada no SEFAZ; só o dado local pra montar o DANFE com
      // segurança está incompleto). O gate de impressão (`getNfceDanfeData`)
      // já recusa imprimir sem `authorization_protocol` — este warning só
      // torna o caso visível em log/alerta, sem repetir dado sensível.
      logError({
        route: 'consultAndUpdateNfceDocument (authorization_protocol ausente)',
        err: new Error('authorized fiscal document missing local authorization protocol — Focus confirmou NFC-e autorizada, mas nenhuma resposta (esta consulta ou uma anterior) trouxe protocolo (nem o fallback legado numero_protocolo).'),
        context: {
          fiscal_document_id: fiscalDocumentId,
          company_id: current.company_id ?? null,
          sale_id: current.sale_id ?? null,
          document_type: current.document_type ?? 'nfce',
          environment: current.environment ?? null,
          provider_ref: providerRef,
          access_key: patch.access_key ?? null,
        },
      })
    }
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
    const status = await applyFocusNfceResponse(admin, fiscalDocumentId, response, providerRef)

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

  // `settings.nfce_environment` (não literal hardcoded) — já confirmado
  // === 'homologacao' pelo gate acima, mas usar a variável real evita
  // outra edição quando o gate for removido numa fase futura. Nome
  // `configuredEnvironment` pra não colidir com o `environment` resolvido
  // mais abaixo a partir de `resolveFocusIntegration`.
  const configuredEnvironment = settings.nfce_environment as FocusEnvironment
  const providerRef = buildProviderRef(companyId, saleId, configuredEnvironment, 'nfce')

  // ─── Claim atômico curto — decide ANTES de qualquer HTTP ────────────────
  const claim = await claimFiscalEmission(admin, companyId, saleId, providerRef, configuredEnvironment, 'nfce')

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
        // CORRIGIDO (venda 703, evidência real de payload): o campo
        // correto é `protocolo`, não `numero_protocolo` — ver
        // `resolveNfceAuthorizationProtocol` e o comentário completo em
        // `FocusNfceConsultaResponse` (types.ts). Emissão nova nunca tem
        // valor local anterior pra preservar, por isso sem 2º argumento.
        authorizationProtocol: resolveNfceAuthorizationProtocol(response),
        xmlPath: response.caminho_xml_nota_fiscal ?? null,
        danfePath: response.caminho_danfe ?? null,
        authorizedAt: new Date().toISOString(),
      } : {}),
    })

    if (!updated) return success(rowToResult(await fetchCurrentFiscalDocumentRow(admin, fiscalDocumentId)))

    // Fase Fiscal 7 — `rpc_complete_fiscal_emission` (RPC compartilhada com
    // NF-e) não tem parâmetro pra qrcode_url (campo exclusivo de NFC-e, sem
    // equivalente em NF-e — ver FocusNfceConsultaResponse). Em vez de mudar
    // a assinatura de uma RPC concorrência-crítica compartilhada (exigiria
    // DROP+CREATE FUNCTION + nova migration pra algo que não afeta a
    // validade fiscal do documento, só a conveniência do DANFE), um UPDATE
    // simples e escopado pelo MESMO claim_token já consumido resolve sem
    // risco: se o claim não for mais o vigente, a condição não bate e nada
    // é escrito — nunca sobrescreve uma tentativa mais nova. Nunca falha a
    // emissão (já autorizada e persistida) por causa disso.
    if (status === 'authorized') {
      if (!response.qrcode_url) {
        // Nunca deveria acontecer numa NFC-e homologação/produção normal —
        // registra alto em vez de deixar a linha ficar com qrcode_url NULL
        // silenciosamente (item 1 do pedido: authorized ⇒ qrcode_url NOT NULL).
        // `getNfceDanfeData` também recusa renderizar o DANFE nesse caso
        // (defesa em profundidade), mas o alerta tem que nascer aqui.
        logError({
          route: 'submitNfceHomologacao (qrcode_url)',
          err: new Error('Focus retornou status "autorizado" sem qrcode_url na resposta.'),
          context: { fiscal_document_id: fiscalDocumentId, sale_id: saleId },
        })
      } else {
        // Escopado pelo MESMO claim_token já consumido: se o claim não for
        // mais o vigente, a condição não bate e nada é escrito — nunca
        // sobrescreve uma tentativa mais nova. `.select('id')` de propósito
        // — só assim dá pra saber quantas linhas o UPDATE realmente afetou
        // (sem select(), o Postgrest não devolve as linhas afetadas) e nunca
        // presumir sucesso silenciosamente (item 1 do pedido).
        const { data: qrUpdateRows, error: qrError } = await (admin as any)
          .from('fiscal_documents')
          .update({ qrcode_url: response.qrcode_url })
          .eq('id', fiscalDocumentId)
          .eq('submission_claim_token', claimToken)
          .select('id')
        if (qrError) {
          logError({ route: 'submitNfceHomologacao (qrcode_url)', err: new Error(qrError.message), context: { fiscal_document_id: fiscalDocumentId } })
        } else if (!qrUpdateRows || qrUpdateRows.length === 0) {
          // Não deveria ser possível: `updated` (não-null, checado acima) já
          // prova que `rpc_complete_fiscal_emission` encontrou a linha com
          // ESTE MESMO claim_token segundos atrás, e a RPC nunca altera
          // `submission_claim_token` (confirmado lendo a migration SQL —
          // não está em nenhum SET da função). Se mesmo assim isto disparar,
          // é uma violação de invariante real — nunca falha a emissão (já
          // autorizada), mas precisa aparecer alto nos logs.
          logError({
            route: 'submitNfceHomologacao (qrcode_url)',
            err: new Error('UPDATE de qrcode_url afetou 0 linhas — invariante de claim_token violado.'),
            context: { fiscal_document_id: fiscalDocumentId, sale_id: saleId },
          })
        } else {
          ;(updated as any).qrcode_url = response.qrcode_url
        }
      }
    }

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
