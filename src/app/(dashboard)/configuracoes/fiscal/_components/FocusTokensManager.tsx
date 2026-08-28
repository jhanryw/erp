'use client'

/**
 * Motor Fiscal Configurável — Certificado/CSC: os 3 tokens da Focus NFe.
 * Nenhum reaparece completo depois de salvo — só mascarado. Cada campo
 * tem seu próprio "Substituir" independente — salvar um nunca exige
 * reenviar os outros dois.
 */

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

type FocusTokenField = 'emission_token_homologacao' | 'emission_token_producao' | 'master_token'

const FIELDS: { field: FocusTokenField; label: string; help: string }[] = [
  { field: 'emission_token_homologacao', label: 'Token de emissão — homologação', help: 'Usado para emitir NF-e/NFC-e enquanto o ambiente configurado for homologação.' },
  { field: 'emission_token_producao', label: 'Token de emissão — produção', help: 'Usado para emitir quando o ambiente configurado for produção. Sem este token, emissão em produção falha explicitamente — nunca reaproveita outro token.' },
  { field: 'master_token', label: 'Token mestre (gerenciamento)', help: 'Exclusivo para cadastrar/atualizar a empresa, certificado e CSC na Focus (/v2/empresas). Nunca usado para emitir documentos.' },
]

interface TokensMasked {
  emissionTokenHomologacaoMasked: string | null
  emissionTokenProducaoMasked: string | null
  masterTokenMasked: string | null
}

const MASKED_KEY: Record<FocusTokenField, keyof TokensMasked> = {
  emission_token_homologacao: 'emissionTokenHomologacaoMasked',
  emission_token_producao: 'emissionTokenProducaoMasked',
  master_token: 'masterTokenMasked',
}

export function FocusTokensManager() {
  const [tokens, setTokens] = useState<TokensMasked | null>(null)
  const [loading, setLoading] = useState(true)
  const [openField, setOpenField] = useState<FocusTokenField | null>(null)
  const [formValue, setFormValue] = useState('')
  const [saving, setSaving] = useState(false)

  function load() {
    setLoading(true)
    fetch('/api/configuracoes/fiscal/focus-tokens')
      .then((r) => r.json())
      .then((json) => setTokens(json))
      .catch(() => toast.error('Erro ao carregar tokens da Focus.'))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  async function save(field: FocusTokenField, e: React.FormEvent) {
    e.preventDefault()
    if (!formValue.trim()) { toast.error('Informe o token.'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/configuracoes/fiscal/focus-tokens', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, token: formValue.trim() }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error('Erro ao salvar token', { description: typeof json.error === 'string' ? json.error : undefined })
        return
      }
      toast.success('Token salvo.')
      setFormValue('')
      setOpenField(null)
      load()
    } catch {
      toast.error('Erro inesperado ao salvar token.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="text-sm text-text-muted flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Carregando...</p>

  return (
    <Card className="p-5 space-y-4 divide-y divide-border">
      <p className="text-sm font-semibold text-text-primary">Tokens da Focus NFe</p>
      {FIELDS.map(({ field, label, help }) => {
        const masked = tokens?.[MASKED_KEY[field]] ?? null
        const isOpen = openField === field
        return (
          <div key={field} className="pt-3 first:pt-0 space-y-2">
            <p className="text-xs font-medium text-text-primary">{label}</p>
            <p className="text-xs text-text-muted">{help}</p>
            <p className="text-xs text-text-muted">{masked ?? 'Não configurado'}</p>
            <Button size="sm" variant={masked ? 'secondary' : 'primary'} onClick={() => { setOpenField(isOpen ? null : field); setFormValue('') }}>
              {masked ? 'Substituir' : 'Configurar'}
            </Button>
            {isOpen && (
              <form onSubmit={(e) => save(field, e)} className="space-y-2 pt-1">
                <input
                  type="password" value={formValue} onChange={(e) => setFormValue(e.target.value)}
                  className="text-xs w-full px-2 py-1.5 rounded-md border border-border bg-bg-card"
                  placeholder="••••••••••••••••••••••••••••••••••••"
                />
                <Button type="submit" size="sm" loading={saving}>Salvar</Button>
              </form>
            )}
          </div>
        )
      })}
    </Card>
  )
}
