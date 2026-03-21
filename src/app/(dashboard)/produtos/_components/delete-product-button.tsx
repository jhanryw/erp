'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

export function DeleteProductButton({ id, redirectAfter = false }: { id: number; redirectAfter?: boolean }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleDelete() {
    if (!confirm(
      'Excluir este produto?\n\nAtenção: produtos vinculados a vendas ou entradas de estoque não poderão ser excluídos.'
    )) return

    setLoading(true)
    try {
      const supabase = createClient()
      const { error } = await supabase.from('products').delete().eq('id', id)

      if (error) {
        const msg = error.message.toLowerCase().includes('foreign key')
          ? 'Produto possui vendas ou estoque vinculados e não pode ser excluído.'
          : error.message
        toast.error('Erro ao excluir produto', { description: msg })
        return
      }

      toast.success('Produto excluído')
      if (redirectAfter) {
        router.push('/produtos')
      } else {
        window.location.reload()
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleDelete}
      loading={loading}
      className="text-error hover:text-error hover:bg-error/10"
    >
      <Trash2 className="w-3.5 h-3.5" />
    </Button>
  )
}
