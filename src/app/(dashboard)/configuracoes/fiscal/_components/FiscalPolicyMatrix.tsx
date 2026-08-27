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

const OPERATION_LABELS: Record<string, { title: string; hint: string }> = {
  pos_retail:   { title: 'Venda balcão', hint: 'PDV, sem entrega nem retirada agendada' },
  pos_pickup:   { title: 'Retirada',      hint: 'PDV, cliente retira depois' },
  pos_delivery: { title: 'Entrega',       hint: 'PDV, com endereço de entrega' },
  wholesale:    { title: 'Atacado',       hint: 'Venda de atacado, qualquer canal' },
  website:      { title: 'Site',          hint: 'Pedidos importados da Nuvemshop' },
  whatsapp:     { title: 'WhatsApp',      hint: 'Venda registrada como canal WhatsApp' },
  manual:       { title: 'Venda manual',  hint: 'Registrada manualmente sem canal específico' },
}

const OPERATION_ORDER = ['pos_retail', 'pos_pickup', 'pos_delivery', 'wholesale', 'website', 'whatsapp', 'manual']

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
        <ToggleButton on={policy.auto_issue} disabled={disabled} onClick={() => save({ auto_issue: !policy.auto_issue })} />
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
        <span className="text-xs text-text-secondary">Comprovante não fiscal</span>
        <ToggleButton on={policy.print_non_fiscal_receipt} onClick={() => save({ print_non_fiscal_receipt: !policy.print_non_fiscal_receipt })} />
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
