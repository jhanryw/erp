'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function CancelSaleButton({ saleId }: { saleId: number }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleCancel() {
    if (!confirm('Cancelar esta venda? O status será alterado para Cancelado e o estoque será restaurado automaticamente.')) return
    setLoading(true)
    try {
      const res = await fetch(`/api/vendas/${saleId}/cancelar`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json()
        toast.error('Erro ao cancelar venda', { description: err.error })
        return
      }

      toast.success('Venda cancelada com sucesso')
      router.refresh()
    } catch {
      toast.error('Erro ao cancelar venda', { description: 'Não foi possível concluir o cancelamento.' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={handleCancel}
      loading={loading}
      className="text-error border-error/30 hover:bg-error/10 hover:border-error/50"
    >
      <XCircle className="w-3.5 h-3.5" />
      Cancelar Venda
    </Button>
  )
}
