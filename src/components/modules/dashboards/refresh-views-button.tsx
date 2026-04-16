'use client'

import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

export function RefreshViewsButton() {
  const [loading, setLoading] = useState(false)

  async function handleRefresh() {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/refresh-views', { method: 'POST' })
      const json = await res.json()
      if (!res.ok || json.ok === false) {
        toast.error('Erro ao atualizar dados', { description: json.error })
      } else {
        toast.success('Dados atualizados!', {
          description: `Views analíticas sincronizadas em ${Math.round(json.duration_ms ?? 0)}ms`,
        })
        // Recarrega a página para mostrar dados frescos
        window.location.reload()
      }
    } catch {
      toast.error('Erro inesperado ao atualizar')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleRefresh}
      loading={loading}
      title="Atualizar dados analíticos (dashboard, relatórios, inteligência)"
    >
      <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
      <span className="hidden sm:inline">Atualizar dados</span>
    </Button>
  )
}
