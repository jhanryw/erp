'use client'

import { useState } from 'react'
import { Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'

type BulkResult = {
  total:    number
  enviados: number
  pulados:  number
  erros:    { id: number; name: string; error: string }[]
}

type State = 'idle' | 'loading' | 'done' | 'error'

export function NuvemshopBulkButton() {
  const [state, setState]   = useState<State>('idle')
  const [result, setResult] = useState<BulkResult | null>(null)

  async function handleBulk() {
    setState('loading')
    try {
      const res  = await fetch('/api/integrations/nuvemshop/products/bulk', { method: 'POST' })
      const data = await res.json()

      if (res.ok) {
        setResult(data as BulkResult)
        setState('done')
      } else {
        setState('error')
      }
    } catch {
      setState('error')
    }
  }

  if (state === 'done' && result) {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
        <Upload className="h-3.5 w-3.5 text-green-600" />
        {result.enviados} enviados · {result.pulados} pulados
        {result.erros.length > 0 ? ` · ${result.erros.length} erro(s)` : ''}
      </span>
    )
  }

  return (
    <Button
      variant="outline"
      onClick={handleBulk}
      disabled={state === 'loading'}
    >
      <Upload className="mr-2 h-4 w-4" />
      {state === 'loading'
        ? 'Enviando...'
        : state === 'error'
        ? 'Tentar novamente'
        : 'Enviar todos para Nuvemshop'}
    </Button>
  )
}
