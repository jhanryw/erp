'use client'

/**
 * Card fiscal CONTEXTUAL — Fase Fiscal 4F, item 7 do pedido.
 *
 * Substitui o card fixo de NF-e (`emitir-nfe-homologacao-card.tsx`,
 * removido). O tipo de documento é RESOLVIDO pelo servidor
 * (`resolveFiscalDocumentType`, em `vendas/[id]/page.tsx`) a partir de
 * `sales.sale_origin`/`shipments.delivery_mode` — este componente só
 * RENDERIZA o resultado, nunca decide nem oferece escolha manual
 * NF-e/NFC-e (item 10 do pedido). Rota de API por trás (admin-only) é a
 * defesa real, não este componente.
 *
 * `resolvedType`:
 *   'nfce'    → balcão/retirada elegível — botões de NFC-e.
 *   'nfe'     → entrega/site — botões de NF-e (mesmo comportamento de
 *               antes, só reembalado neste card contextual).
 *   'blocked' → modalidade de entrega ausente/inconsistente — mostra o
 *               motivo, nenhum botão de emissão.
 */

import { useState } from 'react'
import { Loader2, Receipt, AlertTriangle, CheckCircle2, XCircle, RefreshCw, UserRound } from 'lucide-react'
import { Card } from '@/components/ui/card'

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

function StatusIcon({ status }: { status: string }) {
  if (status === 'authorized') return <CheckCircle2 className="w-4 h-4 text-emerald-600" />
  if (status === 'pending' || status === 'draft') return <Loader2 className="w-4 h-4 text-amber-500" />
  return <XCircle className="w-4 h-4 text-red-500" />
}

interface DocumentoFiscalCardProps {
  saleId: number
  resolvedType: 'nfe' | 'nfce' | 'blocked'
  blockedReason: string | null
  /** CPF já mascarado (`maskCPF`), só quando presente E válido — nunca o CPF cru. `null` = consumidor não identificado. */
  maskedCpf: string | null
}

export function DocumentoFiscalCard({ saleId, resolvedType, blockedReason, maskedCpf }: DocumentoFiscalCardProps) {
  const [busy, setBusy] = useState<'emitir' | 'consultar' | null>(null)
  const [result, setResult] = useState<EmissionResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const basePath = resolvedType === 'nfce' ? '/api/fiscal/nfce' : '/api/fiscal/nfe'
  const documentLabel = resolvedType === 'nfce' ? 'NFC-e' : 'NF-e'

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
        // 200/422 estruturado — a rota resolveu um tipo diferente do
        // esperado (ex.: a venda mudou entre o carregamento da página e o
        // clique). Nunca deveria acontecer no fluxo normal (o card já
        // mostra o tipo resolvido), mas tratado explicitamente mesmo
        // assim — nunca um erro genérico silencioso.
        setError(data.reason)
        return
      }
      setResult(data.emission ?? data.status)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro desconhecido.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card padding="md" className="border-amber-500/30">
      <div className="flex items-center gap-2 mb-1">
        <Receipt className="w-4 h-4 text-brand" />
        <h3 className="text-sm font-semibold text-text-primary">Fiscal</h3>
      </div>

      {resolvedType === 'blocked' ? (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
          <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
          <p className="text-xs text-red-600 dark:text-red-400">{blockedReason ?? 'Não foi possível determinar o documento fiscal desta venda.'}</p>
        </div>
      ) : (
        <>
          <p className="text-xs text-text-secondary mb-2">
            Documento fiscal recomendado: <span className="font-semibold text-text-primary">{documentLabel}</span>
          </p>

          {resolvedType === 'nfce' && (
            <div className="flex items-center gap-2 text-xs text-text-secondary mb-3">
              <UserRound className="w-3.5 h-3.5 text-text-muted" />
              {maskedCpf
                ? <span>Consumidor: CPF será incluído (<code className="font-mono">{maskedCpf}</code>)</span>
                : <span>Consumidor: <span className="font-medium">Não identificado</span></span>}
            </div>
          )}

          <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2 mb-3">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
            <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">
              AMBIENTE DE HOMOLOGAÇÃO — SEM VALIDADE FISCAL
            </p>
          </div>

          <div className="flex gap-2 mb-3">
            <button
              onClick={() => call('emitir')}
              disabled={busy !== null}
              className="inline-flex items-center gap-2 text-xs font-medium text-white bg-brand rounded-md px-3 py-1.5 hover:bg-brand-dark transition-colors disabled:opacity-50"
            >
              {busy === 'emitir' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Receipt className="w-3 h-3" />}
              Emitir {documentLabel} de homologação
            </button>
            <button
              onClick={() => call('consultar')}
              disabled={busy !== null}
              className="inline-flex items-center gap-2 text-xs text-text-secondary border border-border rounded-md px-3 py-1.5 hover:bg-bg-hover transition-colors disabled:opacity-50"
            >
              {busy === 'consultar' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Verificar status
            </button>
          </div>

          {error && <p className="text-xs text-red-500 mb-2">{error}</p>}

          {result && (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex items-center gap-2">
                <StatusIcon status={result.status} />
                <span className="text-sm font-medium text-text-primary">{STATUS_LABELS[result.status] ?? result.status}</span>
              </div>

              {result.validationErrors.length > 0 && (
                <div className="text-xs text-amber-600 dark:text-amber-400 space-y-0.5">
                  <p className="font-medium">Pendências:</p>
                  <ul className="list-disc list-inside">
                    {result.validationErrors.map((e) => <li key={e.code}>{e.message}</li>)}
                  </ul>
                </div>
              )}

              {result.status === 'authorized' && result.accessKey && (
                <div className="text-xs text-text-secondary">
                  <p><span className="text-text-muted">Chave de acesso:</span> <code className="font-mono">{result.accessKey}</code></p>
                  {result.number && <p><span className="text-text-muted">Número/Série:</span> {result.number}/{result.series}</p>}
                </div>
              )}

              {(result.status === 'authorization_failed' || result.status === 'submission_error') && (
                <p className="text-xs text-red-500">
                  {result.statusMessage ?? result.submissionErrorMessage ?? 'Falha não detalhada.'}
                  {result.statusSefaz && <span className="text-text-muted"> (SEFAZ {result.statusSefaz})</span>}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  )
}
