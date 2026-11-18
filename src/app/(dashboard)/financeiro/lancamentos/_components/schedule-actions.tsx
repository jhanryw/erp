'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

// Ações sobre pagamento agendado. Nada aqui é automático: a confirmação é
// sempre um clique explícito. O servidor condiciona o UPDATE a
// payment_status = 'scheduled' (409 se outra operação já alterou o registro).
export function ScheduleActions({ id, scheduledAt }: { id: number; scheduledAt: string | null }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function run(body: Record<string, string>, okMsg: string) {
    setLoading(true)
    try {
      const res = await fetch(`/api/financeiro/lancamentos/${id}/agendamento`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error('Não foi possível concluir', { description: json.error })
        router.refresh()
        return
      }
      toast.success(okMsg)
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  function confirmPayment() {
    if (!window.confirm('Confirmar que este pagamento foi efetivado? Ele passará a compor o caixa realizado (data de pagamento = hoje).')) return
    void run({ action: 'confirm' }, 'Pagamento confirmado')
  }

  function reschedule() {
    const next = window.prompt('Nova data programada (AAAA-MM-DD):', scheduledAt ?? '')
    if (!next) return
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) {
      toast.error('Data inválida. Use o formato AAAA-MM-DD.')
      return
    }
    void run({ action: 'reschedule', paid_at: next }, 'Pagamento reagendado')
  }

  function cancelSchedule() {
    if (!window.confirm('Cancelar o agendamento? O lançamento volta a Pendente.')) return
    void run({ action: 'cancel' }, 'Agendamento cancelado')
  }

  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="sm" className="text-xs px-2 text-success" onClick={confirmPayment} disabled={loading}>
        Confirmar
      </Button>
      <Button variant="ghost" size="sm" className="text-xs px-2" onClick={reschedule} disabled={loading}>
        Reagendar
      </Button>
      <Button variant="ghost" size="sm" className="text-xs px-2" onClick={cancelSchedule} disabled={loading}>
        Cancelar
      </Button>
    </div>
  )
}
