'use client'

/**
 * CSC (Código de Segurança do Contribuinte) — seção 28/54 do pedido.
 * Token nunca reaparece completo depois de salvo — só mascarado.
 */

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export function CscManager() {
  const [cscId, setCscId] = useState<string | null>(null)
  const [tokenMasked, setTokenMasked] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [formCscId, setFormCscId] = useState('')
  const [formToken, setFormToken] = useState('')
  const [saving, setSaving] = useState(false)

  function load() {
    setLoading(true)
    fetch('/api/configuracoes/fiscal/csc')
      .then((r) => r.json())
      .then((json) => { setCscId(json.cscId ?? null); setTokenMasked(json.cscTokenMasked ?? null) })
      .catch(() => toast.error('Erro ao carregar CSC.'))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!formCscId.trim() || !formToken.trim()) { toast.error('Informe CSC ID e CSC Token.'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/configuracoes/fiscal/csc', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csc_id: formCscId.trim(), csc_token: formToken.trim() }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error('Erro ao salvar CSC', { description: typeof json.error === 'string' ? json.error : undefined })
        return
      }
      // Local e Focus são reportados SEPARADAMENTE — salvar localmente
      // nunca implica "sincronizado e pronto para emitir NFC-e".
      toast.success('CSC salvo localmente.')
      if (json.focus?.status === 'success') {
        toast.success('CSC sincronizado com a Focus.')
      } else {
        toast.error('Falha ao sincronizar CSC com a Focus', { description: json.focus?.lastError ?? undefined })
      }
      setFormCscId(''); setFormToken(''); setShowForm(false)
      load()
    } catch {
      toast.error('Erro inesperado ao salvar CSC.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="text-sm text-text-muted flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Carregando...</p>

  return (
    <Card className="p-5 space-y-3">
      <p className="text-sm font-semibold text-text-primary">CSC (NFC-e)</p>
      {cscId ? (
        <div className="text-xs text-text-muted space-y-1">
          <p>CSC ID: {cscId}</p>
          <p>CSC Token: {tokenMasked ?? 'não configurado'}</p>
        </div>
      ) : (
        <p className="text-xs text-text-muted">CSC não configurado ainda.</p>
      )}

      <Button size="sm" variant={cscId ? 'secondary' : 'primary'} onClick={() => setShowForm((v) => !v)}>
        {cscId ? 'Substituir' : 'Configurar CSC'}
      </Button>

      {showForm && (
        <form onSubmit={save} className="space-y-2 pt-2 border-t border-border">
          <div>
            <label className="text-xs text-text-secondary block mb-1">CSC ID</label>
            <input
              value={formCscId} onChange={(e) => setFormCscId(e.target.value)}
              className="text-xs w-full px-2 py-1.5 rounded-md border border-border bg-bg-card"
              placeholder="000001"
            />
          </div>
          <div>
            <label className="text-xs text-text-secondary block mb-1">CSC Token</label>
            <input
              type="password" value={formToken} onChange={(e) => setFormToken(e.target.value)}
              className="text-xs w-full px-2 py-1.5 rounded-md border border-border bg-bg-card"
              placeholder="••••••••••••••••••••••••••••••••••••"
            />
          </div>
          <Button type="submit" size="sm" loading={saving}>Salvar CSC</Button>
        </form>
      )}
    </Card>
  )
}
