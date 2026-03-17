'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

export function DeleteCostButton({ id }: { id: number }) {
  const [loading, setLoading] = useState(false)

  async function handleDelete() {
    if (!confirm('Excluir este custo de marketing? Esta ação não pode ser desfeita.')) return
    setLoading(true)
    try {
      const supabase = createClient()
      const { error } = await supabase.from('marketing_costs').delete().eq('id', id)
      if (error) {
        toast.error('Erro ao excluir custo', { description: error.message })
        return
      }
      toast.success('Custo excluído')
      window.location.reload()
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
