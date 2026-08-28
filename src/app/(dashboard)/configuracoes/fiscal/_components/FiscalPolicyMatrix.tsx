'use client'

/**
 * Motor Fiscal Configurável — matriz de políticas por operação.
 *
 * Cada card salva SOZINHO (PUT individual ao alternar qualquer campo) —
 * nunca depende de um botão "Salvar tudo" no fim da página, então uma
 * mudança nunca fica pendente por engano se o admin sair da página cedo.
 * A alteração vale IMEDIATAMENTE pra próxima venda — sem deploy, sem
 * migration, sem restart (critério de aceite do pedido).
 *
 * UX (seção 20 do pedido): quando `fiscal_enabled=false`, os demais
 * controles ficam visualmente desabilitados (mas o valor salvo é
 * preservado, só não é editável até religar o fiscal). Quando
 * `auto_issue=false`, `auto_print` fica com uma nota de dependência
 * (nunca dispara impressão automática de uma emissão que não acontece).
 */

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/card'

type DocumentMode = 'auto' | 'nfce' | 'nfe' | 'none'

interface Policy {
  operation_type: string
  fiscal_enabled: boolean
  document_mode: DocumentMode
  auto_issue: boolean
  auto_print: boolean
  print_non_fiscal_receipt: boolean
  manual_issue_allowed: boolean
  updated_at: string
}

// Consolidado de 7 para 4 operações (revisão desta fase) — WhatsApp/manual/
// PDV continuam existindo como sales_channel/sale_origin da venda, mas não
// têm mais um card/política própria: são classificados pela NATUREZA da
// operação (varejo sem entrega, varejo com entrega, ou atacado), não pelo
// canal. Ver resolveOperationType.ts pra precedência exata (website checa
// primeiro, inclusive pra venda de atacado feita pelo site).
const OPERATION_LABELS: Record<string, { title: string; hint: string }> = {
  retail_pickup:   { title: 'Varejo retirada', hint: 'Balcão, retirada — qualquer canal (PDV, WhatsApp, manual) sem entrega' },
  retail_delivery: { title: 'Varejo entrega',  hint: 'Venda de varejo com endereço de entrega — qualquer canal' },
  wholesale:       { title: 'Atacado',         hint: 'Venda de atacado fora do site (PDV, WhatsApp, manual)' },
  website:         { title: 'Site',            hint: 'Pedidos da Nuvemshop — inclusive atacado feito pelo site' },
}

const OPERATION_ORDER = ['retail_pickup', 'retail_delivery', 'wholesale', 'website']

const DOCUMENT_MODE_LABELS: Record<DocumentMode, string> = {
  auto: 'Automático', nfce: 'NFC-e', nfe: 'NF-e', none: 'Nenhum',
}

function ToggleButton({ on, disabled, onClick, labelOn = 'ON', labelOff = 'OFF' }: { on: boolean; disabled?: boolean; onClick: () => void; labelOn?: string; labelOff?: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${disabled ? 'opacity-40 cursor-not-allowed' : ''} ${
        on ? 'bg-brand text-white' : 'bg-bg-card border border-border text-text-secondary'
      }`}
    >
      {on ? labelOn : labelOff}
    </button>
  )
}

function PolicyCard({ policy, onSaved }: { policy: Policy; onSaved: (p: Policy) => void }) {
  const [saving, setSaving] = useState(false)
  const label = OPERATION_LABELS[policy.operation_type] ?? { title: policy.operation_type, hint: '' }

  async function save(patch: Partial<Policy>) {
    const next = { ...policy, ...patch }
    setSaving(true)
    try {
      const res = await fetch('/api/configuracoes/fiscal/policies', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation_type: next.operation_type,
          fiscal_enabled: next.fiscal_enabled,
          document_mode: next.document_mode,
          auto_issue: next.auto_issue,
          auto_print: next.auto_print,
          print_non_fiscal_receipt: next.print_non_fiscal_receipt,
          manual_issue_allowed: next.manual_issue_allowed,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error('Erro ao salvar política fiscal', { description: typeof json.error === 'string' ? json.error : 'Verifique os dados.' })
        return
      }
      onSaved(json.policy)
      toast.success(`${label.title}: configuração salva`)
    } catch {
      toast.error('Erro inesperado ao salvar.')
    } finally {
      setSaving(false)
    }
  }

  const disabled = !policy.fiscal_enabled

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-text-primary">{label.title}</p>
          <p className="text-xs text-text-muted">{label.hint}</p>
        </div>
        <div className="flex items-center gap-2">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin text-text-muted" />}
          <span className="text-xs text-text-muted">Fiscal</span>
          <ToggleButton on={policy.fiscal_enabled} onClick={() => save({ fiscal_enabled: !policy.fiscal_enabled })} />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-text-secondary">Documento</span>
        <div className={`flex gap-1 ${disabled ? 'opacity-40' : ''}`}>
          {(['auto', 'nfce', 'nfe', 'none'] as DocumentMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              disabled={disabled}
              onClick={() => save({ document_mode: mode })}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold ${disabled ? 'cursor-not-allowed' : ''} ${
                policy.document_mode === mode ? 'bg-brand text-white' : 'bg-bg-card border border-border text-text-secondary'
              }`}
            >
              {DOCUMENT_MODE_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-text-secondary">Emitir automaticamente</span>
        <ToggleButton
          on={policy.auto_issue}
          disabled={disabled}
          onClick={() => {
            const turningOn = !policy.auto_issue
            // Regra definitiva de impressão/QR Code: emissão automática e
            // comprovante não fiscal nunca coexistem — ligar uma desliga a
            // outra no MESMO salvamento (nunca um estado intermediário
            // inválido persistido, nem que seja por um instante).
            save(turningOn ? { auto_issue: true, print_non_fiscal_receipt: false } : { auto_issue: false })
          }}
        />
      </div>

      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs text-text-secondary">Imprimir automaticamente</span>
          {!policy.auto_issue && policy.auto_print && (
            <p className="text-[10px] text-warning">⚠ sem efeito enquanto "Emitir automaticamente" estiver desligado</p>
          )}
        </div>
        <ToggleButton on={policy.auto_print} disabled={disabled} onClick={() => save({ auto_print: !policy.auto_print })} />
      </div>

      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs text-text-secondary">Comprovante não fiscal</span>
          {policy.auto_issue && (
            <p className="text-[10px] text-warning">⚠ desligado — com emissão automática, o documento fiscal é o comprovante</p>
          )}
        </div>
        <ToggleButton
          on={policy.print_non_fiscal_receipt}
          disabled={policy.auto_issue}
          onClick={() => save({ print_non_fiscal_receipt: !policy.print_non_fiscal_receipt })}
        />
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-text-secondary">Permitir emissão manual</span>
        <ToggleButton on={policy.manual_issue_allowed} disabled={disabled} onClick={() => save({ manual_issue_allowed: !policy.manual_issue_allowed })} />
      </div>
    </Card>
  )
}

export function FiscalPolicyMatrix() {
  const [policies, setPolicies] = useState<Policy[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/configuracoes/fiscal/policies')
      .then((r) => r.json())
      .then((json) => {
        if (json.error) { setError('Erro ao carregar políticas fiscais.'); return }
        setPolicies(json.policies ?? [])
      })
      .catch(() => setError('Erro ao carregar políticas fiscais.'))
  }, [])

  if (error) return <p className="text-sm text-red-500">{error}</p>
  if (!policies) return <p className="text-sm text-text-muted flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Carregando políticas...</p>
  if (policies.length === 0) {
    return <p className="text-sm text-text-muted">Nenhuma política fiscal configurada ainda para esta empresa.</p>
  }

  const sorted = [...policies].sort((a, b) => OPERATION_ORDER.indexOf(a.operation_type) - OPERATION_ORDER.indexOf(b.operation_type))

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {sorted.map((p) => (
        <PolicyCard
          key={p.operation_type}
          policy={p}
          onSaved={(updated) => setPolicies((prev) => prev!.map((x) => (x.operation_type === updated.operation_type ? updated : x)))}
        />
      ))}
    </div>
  )
}
