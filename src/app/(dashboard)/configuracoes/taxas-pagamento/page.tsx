'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, CreditCard, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

type FeeRow = {
  id: number
  payment_method: string
  installments: number
  label: string
  fee_percentage: number
}

const METHOD_GROUPS: { key: string; title: string; description: string }[] = [
  { key: 'pix',            title: 'PIX',               description: 'Taxa cobrada pela operadora no recebimento via PIX.' },
  { key: 'card',           title: 'Cartão de Crédito', description: 'Taxa por parcelamento cobrada pela maquininha.' },
  { key: 'nuvemshop_pix',  title: 'Nuvemshop — PIX',   description: 'Taxa do gateway da Nuvemshop para pagamentos via PIX.' },
  { key: 'nuvemshop_card', title: 'Nuvemshop — Cartão', description: 'Taxa do gateway da Nuvemshop para pagamentos via cartão.' },
]

export default function TaxasPagamentoPage() {
  const [fees, setFees]       = useState<FeeRow[]>([])
  const [draft, setDraft]     = useState<Record<number, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)

  async function load() {
    setLoading(true)
    const res  = await fetch('/api/configuracoes/taxas-pagamento')
    const json = await res.json()
    const rows: FeeRow[] = json.fees ?? []
    setFees(rows)
    const initial: Record<number, string> = {}
    rows.forEach(r => { initial[r.id] = String(r.fee_percentage) })
    setDraft(initial)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function save() {
    setSaving(true)
    const payload = fees.map(r => ({
      id: r.id,
      fee_percentage: parseFloat(draft[r.id] ?? '0') || 0,
    }))

    const res  = await fetch('/api/configuracoes/taxas-pagamento', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fees: payload }),
    })
    const json = await res.json()
    setSaving(false)

    if (!res.ok) {
      toast.error('Erro ao salvar', { description: json.error ?? 'Tente novamente.' })
      return
    }
    toast.success('Taxas salvas com sucesso!')
    load()
  }

  function handleChange(id: number, value: string) {
    // Permite digitar livremente (incluindo ponto decimal)
    if (/^(\d{0,3}([.,]\d{0,4})?)?$/.test(value)) {
      setDraft(p => ({ ...p, [id]: value.replace(',', '.') }))
    }
  }

  const grouped = METHOD_GROUPS.map(g => ({
    ...g,
    rows: fees.filter(f => f.payment_method === g.key),
  })).filter(g => g.rows.length > 0)

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-text-muted">Carregando taxas...</p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/configuracoes">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div className="flex items-center gap-2">
          <CreditCard className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Taxas de Pagamento</h2>
            <p className="text-sm text-text-muted">Configure as taxas por método e parcelamento</p>
          </div>
        </div>
      </div>

      {/* Info box */}
      <div className="rounded-lg border border-border bg-bg-overlay px-4 py-3 text-sm text-text-muted space-y-1">
        <p>As taxas são registradas automaticamente como <strong className="text-text-secondary">despesa</strong> a cada venda.</p>
        <p>O faturamento sempre reflete o valor cobrado do cliente. A taxa fica separada no financeiro.</p>
      </div>

      {/* Grupos */}
      {grouped.map(group => (
        <div key={group.key} className="card p-6 space-y-4">
          <div className="border-b border-border pb-3">
            <h3 className="text-sm font-semibold text-text-primary">{group.title}</h3>
            <p className="text-xs text-text-muted mt-0.5">{group.description}</p>
          </div>

          <div className="space-y-2">
            {group.rows.map(row => (
              <div key={row.id} className="flex items-center justify-between gap-4">
                <span className="text-sm text-text-primary w-32">{row.label}</span>
                <div className="flex items-center gap-2 flex-1 max-w-[180px]">
                  <input
                    type="text"
                    inputMode="decimal"
                    className="input-base text-sm text-right w-full"
                    value={draft[row.id] ?? '0'}
                    onChange={e => handleChange(row.id, e.target.value)}
                    placeholder="0.00"
                  />
                  <span className="text-sm text-text-muted w-4 shrink-0">%</span>
                </div>
                <span className="text-xs text-text-muted w-24 text-right">
                  {(() => {
                    const pct = parseFloat(draft[row.id] ?? '0') || 0
                    if (pct === 0) return 'Sem taxa'
                    return `R$ ${(100 * pct / 100).toFixed(2)} a cada R$ 100`
                  })()}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}

      {fees.length === 0 && (
        <div className="card p-8 text-center space-y-2">
          <CreditCard className="w-8 h-8 text-text-muted mx-auto" />
          <p className="text-sm font-medium text-text-primary">Nenhuma taxa configurada</p>
          <p className="text-xs text-text-muted">Execute a migration 020 no Supabase para criar as linhas padrão.</p>
        </div>
      )}

      {fees.length > 0 && (
        <div className="flex justify-end">
          <Button onClick={save} loading={saving}>
            <Save className="w-4 h-4 mr-2" />
            Salvar todas as taxas
          </Button>
        </div>
      )}
    </div>
  )
}
