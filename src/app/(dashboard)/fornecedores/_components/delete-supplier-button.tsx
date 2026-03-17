'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

export function DeleteSupplierButton({ id, redirectAfter = false }: { id: number; redirectAfter?: boolean }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleDelete() {
    if (!confirm(
      'Excluir este fornecedor?\n\nAtenção: fornecedores vinculados a produtos ou entradas de estoque não poderão ser excluídos.'
    )) return

    setLoading(true)
    try {
      const supabase = createClient()
      const { error } = await supabase.from('suppliers').delete().eq('id', id)

      if (error) {
        // Exibe mensagem amigável para violação de FK
        const msg = error.message.toLowerCase().includes('foreign key')
          ? 'Fornecedor possui produtos ou estoque vinculados e não pode ser excluído.'
          : error.message
        toast.error('Erro ao excluir fornecedor', { description: msg })
        return
      }

      toast.success('Fornecedor excluído')
      if (redirectAfter) {
        router.push('/fornecedores')
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
