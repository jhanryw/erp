'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function DeleteSupplierButton({
  id,
  redirectAfter = false,
}: {
  id: number
  redirectAfter?: boolean
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleDelete() {
    if (!confirm(
      'Excluir este fornecedor?\n\nAtenção: fornecedores vinculados a produtos ou entradas de estoque não podem ser excluídos.'
    )) return

    setLoading(true)

    try {
      const res = await fetch(`/api/fornecedores/${id}`, { method: 'DELETE' })
      const json = await res.json()

      if (!res.ok) {
        toast.error('Erro ao excluir fornecedor', {
          description: json.error ?? 'Falha inesperada ao excluir.',
        })
        return
      }

      toast.success('Fornecedor excluído com sucesso')

      if (redirectAfter) {
        router.push('/fornecedores')
        router.refresh()
        return
      }

      router.refresh()
    } catch {
      toast.error('Erro ao excluir fornecedor', {
        description: 'Não foi possível concluir a exclusão.',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button
      variant="danger"
      size="sm"
      onClick={handleDelete}
      disabled={loading}
    >
      <Trash2 className="w-3.5 h-3.5 mr-1" />
      {loading ? 'Excluindo...' : 'Excluir'}
    </Button>
  )
}
