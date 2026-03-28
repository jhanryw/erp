'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function DeleteCustomerButton({
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
      'Excluir este cliente?\n\nAtenção: clientes vinculados a vendas não podem ser excluídos.'
    )

    if (!confirmed) return

    setLoading(true)

    try {
      const res = await fetch(`/api/clientes/${id}`, { method: 'DELETE' })
      const json = await res.json()

      if (!res.ok) {
        toast.error('Erro ao excluir cliente', {
          description: json.error ?? 'Falha inesperada ao excluir.',
        })
        return
      }

      toast.success('Cliente excluído com sucesso')

      if (redirectAfter) {
        router.push('/clientes')
        router.refresh()
        return
      }

      router.refresh()
    } catch {
      toast.error('Erro ao excluir cliente', {
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
