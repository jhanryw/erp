'use client'

/**
 * Card fiscal — Fase Fiscal 6 (PDV comprovante/NFC-e/NF-e).
 *
 * Substitui a versão anterior (Fase Fiscal 4F), que só mostrava UM botão
 * de emissão, escolhido automaticamente por `resolveFiscalDocumentType` —
 * o operador nunca podia pedir NF-e pra uma venda que resolvia pra NFC-e
 * (ex. atacado balcão que o cliente quer nota completa). Agora mostra as
 * DUAS seções (NFC-e e NF-e) sempre, cada uma com sua própria elegibili-
 * dade e estado:
 *
 *   - NFC-e só é permitida quando `resolvedType === 'nfce'` (mesma regra
 *     fiscal de sempre — endereço/origem não presencial não cabe em
 *     NFC-e). Fora disso, o botão fica desabilitado com o motivo visível.
 *   - NF-e nunca tem esse bloqueio prévio (mesmo comportamento da rota
 *     `/api/fiscal/nfe/emitir-homologacao`, que sempre tenta e deixa
 *     `validateNfeReadiness` reportar o que falta).
 *
 * `initialDocuments` vem do SERVER (vendas/[id]/page.tsx) — mostra status
 * real já no primeiro render, sem exigir um clique em "verificar status"
 * (item 18 do pedido). O botão "Verificar status" continua existindo pra
 * reconsultar a Focus sob demanda — nunca automático/polling.
 *
 * Quando uma tentativa de NF-e falha por destinatário incompleto
 * (qualquer código `destinatario_*`), aparece "Completar dados fiscais" —
 * abre o mesmo formulário do PDV, pré-carregado com o que já existe
 * (`GET /api/fiscal/recipient`), salva (`POST /api/fiscal/recipient`) e
 * tenta emitir de novo automaticamente (seção 19 do pedido).
 */

import { useState } from 'react'
import { Loader2, Receipt, AlertTriangle, CheckCircle2, XCircle, RefreshCw, UserRound, FileText, FileDown } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { FiscalRecipientFields, EMPTY_FISCAL_RECIPIENT, type FiscalRecipientValue } from '@/components/vendas/FiscalRecipientFields'
import { resolveFocusResourceUrl } from '@/lib/fiscal/resolveFocusResourceUrl'
import type { FocusEnvironment } from '@/lib/integrations/focus/types'

interface EmissionResult {
  status: string
  accessKey: string | null
  number: string | null
  series: string | null
  statusSefaz: string | null
  statusMessage: string | null
  submissionErrorCode: string | null
  submissionErrorMessage: string | null
  validationErrors: { code: string; message: string }[]
  xmlPath?: string | null
  danfePath?: string | null
  /** Ambiente REAL devolvido pela API (`SubmitNfeResult.environment`) — presente em toda resposta de emissão/consulta, nunca um literal fixo. */
  environment?: FocusEnvironment
}

export interface InitialFiscalDocument {
  id: number
  document_type: 'nfe' | 'nfce'
  status: string
  /** Ambiente EM QUE ESTE DOCUMENTO foi emitido — nunca confundir com o ambiente configurado atualmente (`currentEnvironment`, que pode já ter mudado desde então). */
  environment: FocusEnvironment
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

/** Badge discreto — mesmo padrão visual de badge já usado no restante do card (texto pequeno, cor de fundo suave). Nunca "Autorizada" sozinho: o operador precisa distinguir teste de documento oficial imediatamente. Exportado pra reaproveitar em vendas/[id]/page.tsx (botão principal de impressão). */
export function EnvironmentBadge({ environment }: { environment: FocusEnvironment }) {
  const isProducao = environment === 'producao'
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${
        isProducao ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
      }`}
    >
      {isProducao ? 'Produção' : 'Homologação'}
    </span>
  )
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Rascunho',
  validation_failed: 'Bloqueado — pendências locais',
  pending: 'Processando na SEFAZ',
  authorized: 'Autorizada',
  authorization_failed: 'Rejeitada / falha na autorização',
  submission_error: 'Erro ao enviar (Focus)',
  cancelled: 'Cancelada',
  cancellation_failed: 'Falha ao cancelar',
}

const TERMINAL_SALE_STATUSES = new Set(['cancelled', 'returned'])

function StatusIcon({ status }: { status: string }) {
  if (status === 'authorized') return <CheckCircle2 className="w-4 h-4 text-emerald-600" />
  if (status === 'pending' || status === 'draft') return <Loader2 className="w-4 h-4 text-amber-500" />
  return <XCircle className="w-4 h-4 text-red-500" />
}

function toResult(doc: InitialFiscalDocument | undefined): EmissionResult | null {
  if (!doc) return null
  return {
    status: doc.status,
    accessKey: doc.access_key,
    number: doc.number,
    series: doc.series,
    statusSefaz: doc.status_sefaz,
    statusMessage: doc.status_message,
    submissionErrorCode: doc.submission_error_code,
    submissionErrorMessage: doc.submission_error_message,
    validationErrors: [],
    xmlPath: doc.xml_path,
    danfePath: doc.danfe_path,
  }
}

interface DocumentoFiscalCardProps {
  saleId: number
  saleStatus: string
  resolvedType: 'nfe' | 'nfce' | 'blocked'
  blockedReason: string | null
  /** CPF já mascarado (`maskCPF`), só quando presente E válido — nunca o CPF cru. `null` = consumidor não identificado. */
  maskedCpf: string | null
  initialDocuments: Record<'nfe' | 'nfce', InitialFiscalDocument | undefined>
  /** Ambiente CONFIGURADO agora por tipo (company_fiscal_settings.nfe_environment/nfce_environment) — usado pra saber se um "autorizado" já existente ainda corresponde ao ambiente atual, nunca lido de fiscal_documents. */
  currentEnvironment: { nfe: FocusEnvironment; nfce: FocusEnvironment }
}

function DocumentTypeSection({
  saleId, type, label, eligible, ineligibleReason, saleBlocked, initial, currentEnvironment,
}: {
  saleId: number
  type: 'nfe' | 'nfce'
  label: string
  eligible: boolean
  ineligibleReason: string | null
  saleBlocked: boolean
  initial: InitialFiscalDocument | undefined
  currentEnvironment: FocusEnvironment
}) {
  const [busy, setBusy] = useState<'emitir' | 'consultar' | null>(null)
  const [result, setResult] = useState<EmissionResult | null>(toResult(initial))
  // Ambiente do `result` atual — SEMPRE um valor real, nunca um literal
  // fixo (achado real, pré-produção: `SubmitNfeResult.environment` agora
  // é propagado ponta a ponta desde `fiscal_documents.environment` — ver
  // `submitNfceHomologacao.ts`/`submitNfeHomologacao.ts`, `rowToResult`).
  // Estado inicial: `initial.environment` (documento já carregado do
  // servidor) ou `currentEnvironment` (config atual da empresa) quando
  // ainda não existe documento nenhum. Depois de qualquer emissão/consulta
  // bem-sucedida, `call()` abaixo atualiza pro `environment` REAL que
  // veio na resposta da API — nunca `currentEnvironment` como suposição
  // quando o dado real já está disponível.
  const [resultEnvironment, setResultEnvironment] = useState<FocusEnvironment>(initial?.environment ?? currentEnvironment)
  const [error, setError] = useState<string | null>(null)
  const [showRecipientForm, setShowRecipientForm] = useState(false)
  const [recipientValue, setRecipientValue] = useState<FiscalRecipientValue>(EMPTY_FISCAL_RECIPIENT)
  const [loadingRecipient, setLoadingRecipient] = useState(false)
  const [savingRecipient, setSavingRecipient] = useState(false)

  const basePath = `/api/fiscal/${type}`

  async function call(action: 'emitir' | 'consultar') {
    const path = action === 'emitir' ? `${basePath}/emitir-homologacao` : `${basePath}/consultar`
    setBusy(action)
    setError(null)
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sale_id: saleId }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ? (typeof data.error === 'string' ? data.error : 'Erro de validação.') : 'Falha na requisição.')
        return
      }
      if (data.reason) {
        setError(data.reason)
        return
      }
      const freshResult = data.emission ?? data.status
      setResult(freshResult)
      // `environment` REAL vem na própria resposta da API
      // (`SubmitNfeResult.environment`) — `currentEnvironment` (config
      // atual da empresa) só entra como último recurso, nunca um literal
      // fixo, pro caso (não esperado) de a resposta vir sem o campo.
      setResultEnvironment(freshResult?.environment ?? currentEnvironment)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro desconhecido.')
    } finally {
      setBusy(null)
    }
  }

  async function openRecipientForm() {
    setShowRecipientForm(true)
    setLoadingRecipient(true)
    try {
      const res = await fetch(`/api/fiscal/recipient?sale_id=${saleId}`)
      const data = await res.json()
      if (res.ok && data.recipient) {
        setRecipientValue({
          nome: data.recipient.nome, cpf: data.recipient.cpf, cnpj: data.recipient.cnpj,
          inscricao_estadual: data.recipient.inscricaoEstadual, indicador_ie: data.recipient.indicadorIe,
          telefone: data.recipient.telefone, cep: data.recipient.cep, logradouro: data.recipient.logradouro,
          numero: data.recipient.numero, complemento: data.recipient.complemento, bairro: data.recipient.bairro,
          municipio: data.recipient.municipio, uf: data.recipient.uf, municipio_ibge: data.recipient.municipioIbge,
          ibge_source: data.recipient.ibgeSource,
        })
      }
    } finally {
      setLoadingRecipient(false)
    }
  }

  async function saveRecipientAndRetry() {
    setSavingRecipient(true)
    setError(null)
    try {
      const res = await fetch('/api/fiscal/recipient', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sale_id: saleId,
          recipient: {
            nome: recipientValue.nome, cpf: recipientValue.cpf, cnpj: recipientValue.cnpj,
            inscricaoEstadual: recipientValue.inscricao_estadual, indicadorIe: recipientValue.indicador_ie,
            telefone: recipientValue.telefone, cep: recipientValue.cep, logradouro: recipientValue.logradouro,
            numero: recipientValue.numero, complemento: recipientValue.complemento, bairro: recipientValue.bairro,
            municipio: recipientValue.municipio, uf: recipientValue.uf, municipioIbge: recipientValue.municipio_ibge,
            ibgeSource: recipientValue.ibge_source,
          },
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Falha ao salvar dados fiscais.')
        return
      }
      setShowRecipientForm(false)
      await call('emitir')
    } finally {
      setSavingRecipient(false)
    }
  }

  const hasDestinatarioIssue = result?.validationErrors?.some((e) => e.code.startsWith('destinatario_')) ?? false
  // Fundação homologação↔produção: um autorizado só bloqueia nova emissão
  // quando foi autorizado NO MESMO ambiente que seria usado agora. Uma
  // homologação autorizada nunca trava o botão pra uma futura emissão em
  // produção (e vice-versa) — a decisão considera o ambiente ALVO, nunca
  // só "existe algo autorizado?". Hoje `currentEnvironment` é sempre
  // 'homologacao' (gate em submitNfeHomologacao.ts/submitNfceHomologacao.ts),
  // então o comportamento observável não muda enquanto produção não for
  // liberada — mas a fórmula já está correta para quando mudar.
  const authorizedInCurrentEnvironment = result?.status === 'authorized' && resultEnvironment === currentEnvironment
  const canEmit = eligible && !saleBlocked && !authorizedInCurrentEnvironment

  // Resolvidos uma vez só — nunca concatenação espalhada no JSX (achado
  // real, venda 703: href={result.danfePath} cru resolvia contra a
  // origem da PÁGINA, nunca contra a Focus, e devolvia 404).
  const danfeFocusUrl = resolveFocusResourceUrl({ path: result?.danfePath, environment: resultEnvironment })
  const xmlFocusUrl = resolveFocusResourceUrl({ path: result?.xmlPath, environment: resultEnvironment })

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-text-primary">{label}</p>
        {result && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium">
            <StatusIcon status={result.status} />
            {STATUS_LABELS[result.status] ?? result.status}
            {result.status === 'authorized' && resultEnvironment && <EnvironmentBadge environment={resultEnvironment} />}
          </span>
        )}
      </div>

      {type === 'nfce' && (
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <UserRound className="w-3.5 h-3.5 text-text-muted" />
          <span>Consumidor: <span className="font-medium">Identificação opcional</span></span>
        </div>
      )}

      {!eligible && !result && (
        <p className="text-xs text-text-muted">{ineligibleReason}</p>
      )}

      {saleBlocked && (
        <p className="text-xs text-red-500">Venda cancelada/devolvida — emissão bloqueada.</p>
      )}

      {(!result || result.status !== 'authorized') && !saleBlocked && (
        <div className="flex gap-2">
          <button
            onClick={() => call('emitir')}
            disabled={busy !== null || !canEmit}
            className="inline-flex items-center gap-2 text-xs font-medium text-white bg-brand rounded-md px-3 py-1.5 hover:bg-brand-dark transition-colors disabled:opacity-50"
          >
            {busy === 'emitir' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Receipt className="w-3 h-3" />}
            Emitir {label}
          </button>
          {result && (
            <button
              onClick={() => call('consultar')}
              disabled={busy !== null}
              className="inline-flex items-center gap-2 text-xs text-text-secondary border border-border rounded-md px-3 py-1.5 hover:bg-bg-hover transition-colors disabled:opacity-50"
            >
              {busy === 'consultar' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Verificar status
            </button>
          )}
        </div>
      )}

      {result?.status === 'authorized' && (
        <button
          onClick={() => call('consultar')}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 text-xs text-text-secondary border border-border rounded-md px-3 py-1.5 hover:bg-bg-hover transition-colors disabled:opacity-50"
        >
          {busy === 'consultar' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Verificar status
        </button>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}

      {result && result.validationErrors.length > 0 && (
        <div className="text-xs text-amber-600 dark:text-amber-400 space-y-0.5">
          <p className="font-medium">Pendências:</p>
          <ul className="list-disc list-inside">
            {result.validationErrors.map((e) => <li key={e.code}>{e.message}</li>)}
          </ul>
          {type === 'nfe' && hasDestinatarioIssue && !showRecipientForm && (
            <button
              onClick={openRecipientForm}
              className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-brand hover:underline"
            >
              Completar dados fiscais
            </button>
          )}
        </div>
      )}

      {showRecipientForm && (
        <div className="space-y-2 pt-1">
          {loadingRecipient ? (
            <p className="text-xs text-text-muted flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Carregando dados atuais…</p>
          ) : (
            <>
              <FiscalRecipientFields mode="nfe" value={recipientValue} onChange={setRecipientValue} />
              <div className="flex gap-2">
                <Button size="sm" onClick={saveRecipientAndRetry} loading={savingRecipient}>Salvar e tentar emitir</Button>
                <Button size="sm" variant="secondary" onClick={() => setShowRecipientForm(false)}>Cancelar</Button>
              </div>
            </>
          )}
        </div>
      )}

      {result?.status === 'authorized' && (
        <div className="space-y-1 border-t border-border pt-2 text-xs text-text-secondary">
          {result.accessKey && <p><span className="text-text-muted">Chave de acesso:</span> <code className="font-mono">{result.accessKey}</code></p>}
          {result.number && <p><span className="text-text-muted">Número/Série:</span> {result.number}/{result.series}</p>}
          {/* Simplificação da arquitetura de impressão (pós-testes reais de
              emissão): o DANFE da FOCUS é o destino PRINCIPAL pra qualquer
              documento autorizado — NFC-e e NF-e. danfe_path/xml_path da
              Focus são caminhos RELATIVOS (caminho_danfe/
              caminho_xml_nota_fiscal) — resolveFocusResourceUrl é o único
              ponto que combina isso com o host certo do ambiente; nunca
              usar result.danfePath/xmlPath direto como href (resolveria
              contra a URL desta página, não da Focus). Autorizado sem
              danfe_path válido → erro explícito, nunca fica em silêncio. */}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            {danfeFocusUrl ? (
              <a href={danfeFocusUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-brand hover:underline">
                <FileText className="w-3.5 h-3.5" /> Abrir DANFE (Focus)
              </a>
            ) : (
              <span className="inline-flex items-center gap-1 text-red-500">
                <AlertTriangle className="w-3.5 h-3.5" /> DANFE da Focus indisponível (danfe_path ausente/inválido)
              </span>
            )}
            {xmlFocusUrl && (
              <a href={xmlFocusUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
                <FileDown className="w-3.5 h-3.5" /> XML
              </a>
            )}
            {/* DANFE NFC-e LOCAL — não é mais o destino padrão (decisão
                pós-testes reais: a Focus já gera um DANFE fiscal adequado).
                Mantido temporariamente SÓ como fallback/debug, nunca como
                botão principal — removido/simplificado numa etapa
                separada, depois de validar impressão física Windows/Epson. */}
            {type === 'nfce' && (
              <a href={`/vendas/${saleId}/nfce?environment=${resultEnvironment}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-text-muted hover:underline text-[11px]">
                <FileText className="w-3 h-3" /> DANFE local (fallback/debug)
              </a>
            )}
          </div>
        </div>
      )}

      {(result?.status === 'authorization_failed' || result?.status === 'submission_error') && (
        <p className="text-xs text-red-500">
          {result.statusMessage ?? result.submissionErrorMessage ?? 'Falha não detalhada.'}
          {result.statusSefaz && <span className="text-text-muted"> (SEFAZ {result.statusSefaz})</span>}
        </p>
      )}
    </div>
  )
}

export function DocumentoFiscalCard({ saleId, saleStatus, resolvedType, blockedReason, maskedCpf, initialDocuments, currentEnvironment }: DocumentoFiscalCardProps) {
  const saleBlocked = TERMINAL_SALE_STATUSES.has(saleStatus)

  return (
    <Card padding="md" className="border-amber-500/30 space-y-3">
      <div className="flex items-center gap-2">
        <Receipt className="w-4 h-4 text-brand" />
        <h3 className="text-sm font-semibold text-text-primary">Fiscal</h3>
      </div>

      <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
        <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
        <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">
          AMBIENTE DE HOMOLOGAÇÃO — SEM VALIDADE FISCAL
        </p>
      </div>

      {resolvedType === 'blocked' && !initialDocuments.nfce && !initialDocuments.nfe && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
          <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
          <p className="text-xs text-red-600 dark:text-red-400">
            {blockedReason ?? 'Não foi possível determinar automaticamente o documento fiscal recomendado.'} NF-e continua disponível abaixo, se aplicável.
          </p>
        </div>
      )}

      {maskedCpf && (
        <p className="text-xs text-text-secondary">CPF do cliente no cadastro: <code className="font-mono">{maskedCpf}</code></p>
      )}

      <DocumentTypeSection
        saleId={saleId} type="nfce" label="NFC-e"
        eligible={resolvedType === 'nfce'}
        ineligibleReason={resolvedType !== 'nfce' ? 'Não elegível para esta venda (modalidade de entrega/origem indica NF-e ou está indeterminada).' : null}
        saleBlocked={saleBlocked}
        initial={initialDocuments.nfce}
        currentEnvironment={currentEnvironment.nfce}
      />
      <DocumentTypeSection
        saleId={saleId} type="nfe" label="NF-e"
        eligible
        ineligibleReason={null}
        saleBlocked={saleBlocked}
        initial={initialDocuments.nfe}
        currentEnvironment={currentEnvironment.nfe}
      />
    </Card>
  )
}
