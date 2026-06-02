'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'

export function ReabrirCaixaButton({ sessionId }: { sessionId: number }) {
  const [open, setOpen]     = useState(false)
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleReopen() {
    if (!reason.trim()) { toast.error('Informe o motivo da reabertura.'); return }
    setLoading(true)
    try {
      const r    = await fetch('/api/caixa/reabrir', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ session_id: sessionId, reason }),
      })
      const json = await r.json()
      if (!r.ok) { toast.error(json.error ?? 'Erro ao reabrir caixa'); return }
      toast.success('Caixa reaberto. Redirecionando...')
      setTimeout(() => { window.location.href = '/caixa' }, 1200)
    } catch {
      toast.error('Erro inesperado')
    } finally {
      setLoading(false)
      setOpen(false)
    }
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <RotateCcw className="w-3.5 h-3.5" />
        Reabrir caixa
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Reabrir caixa fechado">
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Esta ação reabre o caixa e limpa o snapshot de fechamento.
            É registrada em auditoria e exige motivo obrigatório.
          </p>
          <Input
            label="Motivo da reabertura"
            placeholder="Ex.: erro no valor contado, correção de lançamento"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={loading}>
              Cancelar
            </Button>
            <Button variant="danger" loading={loading} onClick={handleReopen} disabled={!reason.trim()}>
              Confirmar reabertura
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
