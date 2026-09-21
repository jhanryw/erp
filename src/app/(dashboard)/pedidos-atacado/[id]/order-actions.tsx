'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { MessageCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ORDER_STATUS_LABEL, type WholesaleOrderStatus } from '@/services/wholesale/orderStatus'

export function OrderActions({ orderId, status, whatsappUrl }: { orderId: string; status: WholesaleOrderStatus; whatsappUrl: string | null }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function change(next: WholesaleOrderStatus) {
    if (!window.confirm(`Marcar este pedido como ${ORDER_STATUS_LABEL[next].toLowerCase()}?`)) return
    setBusy(true)
    try {
      const res = await fetch(`/api/pedidos-atacado/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        toast.error('Não foi possível alterar o status', { description: json.error })
        return
      }
      toast.success(`Pedido marcado como ${ORDER_STATUS_LABEL[next].toLowerCase()}.`)
      router.refresh()
    } catch {
      toast.error('Não foi possível alterar o status', { description: 'Erro de rede.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {whatsappUrl && (
        <a href={whatsappUrl} target="_blank" rel="noopener noreferrer">
          <Button type="button" size="sm"><MessageCircle className="mr-2 h-4 w-4" />Abrir WhatsApp</Button>
        </a>
      )}
      {status !== 'finalized' && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => change('finalized')}>Marcar como finalizado</Button>}
      {status !== 'cancelled' && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => change('cancelled')}>Cancelar pedido</Button>}
      {status !== 'pending' && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => change('pending')}>Voltar para pendente</Button>}
    </div>
  )
}
