'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

export function CancelSaleButton({ saleId }: { saleId: number }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleCancel() {
    if (!confirm('Cancelar esta venda? O status será alterado para Cancelado e o estoque será restaurado automaticamente.')) return
    setLoading(true)
    try {
      const supabase = createClient()
      const { error } = await (supabase as any)
        .from('sales')
        .update({ status: 'cancelled' })
        .eq('id', saleId)

      if (error) {
        toast.error('Erro ao cancelar venda', { description: error.message })
        return
      }

      toast.success('Venda cancelada com sucesso')
      router.refresh()
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
