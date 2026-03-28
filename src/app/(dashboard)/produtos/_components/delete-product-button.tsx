'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function DeleteProductButton({
  id,
  redirectAfter = false,
}: {
  id: number
  redirectAfter?: boolean
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleDelete() {
    const confirmed = window.confirm(
      'Excluir este produto?\n\nAtenção: produtos vinculados a vendas ou entradas de estoque podem não ser excluídos.'
    )

    if (!confirmed) return

    setLoading(true)

    try {
      const res = await fetch(`/api/produtos/${id}`, {
        method: 'DELETE',
      })

      const json = await res.json()

      if (!res.ok) {
        toast.error('Erro ao excluir produto', {
          description: json.error ?? 'Falha inesperada ao excluir.',
        })
        return
      }

      toast.success('Produto excluído com sucesso')

      if (redirectAfter) {
        router.push('/produtos')
        router.refresh()
        return
      }

      router.refresh()
    } catch  {
      toast.error('Erro ao excluir produto', {
        description: 'Não foi possível concluir a exclusão.',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
  <Button
    type="button"
    variant="danger"
    size="sm"
    onClick={handleDelete}
    disabled={loading}
  >
    <Trash2 className="h-4 w-4 mr-2" />
    {loading ? 'Excluindo...' : 'Excluir'}
  </Button>
  )
}