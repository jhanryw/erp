'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function ReturnButton({ saleId }: { saleId: number }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleReturn() {
    if (!confirm('Confirmar devolução desta venda? O estoque dos itens será restaurado automaticamente.')) return
    setLoading(true)
    try {
      const res = await fetch(`/api/vendas/${saleId}/devolucao`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json()
        toast.error('Erro ao registrar devolução', { description: err.error })
        return
      }
      toast.success('Devolução registrada com sucesso')
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button variant="secondary" size="sm" onClick={handleReturn} loading={loading}>
      <RotateCcw className="w-3.5 h-3.5" />
      Registrar Devolução
    </Button>
  )
}
