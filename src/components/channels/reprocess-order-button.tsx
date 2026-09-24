'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

const ACTION_LABEL: Record<string, string> = {
  imported: 'Venda criada.', already_imported: 'Pedido já tinha virado venda.', costs_synced: 'Custos atualizados.',
  awaiting_payment: 'Pedido ainda aguardando pagamento.', cancelled: 'Pedido cancelado no canal.',
  needs_attention: 'Pedido continua precisando de atenção.', ignored: 'Pedido ignorado.',
}

export function ReprocessOrderButton({ channelOrderId }: { channelOrderId: number }) {
  const [busy, setBusy] = useState(false)
  const router = useRouter()
  async function run() {
    setBusy(true)
    try {
      const res = await fetch(`/api/channels/orders/${channelOrderId}/reprocess`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) toast.error('Não foi possível reprocessar', { description: json.error })
      else toast.success(ACTION_LABEL[json.result?.action] ?? 'Reprocessado.')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button size="sm" variant="secondary" onClick={run} loading={busy}>
      <RefreshCw className="h-3.5 w-3.5" /> Reprocessar
    </Button>
  )
}
