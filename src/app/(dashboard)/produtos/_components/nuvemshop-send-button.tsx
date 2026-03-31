'use client'

import { useState } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  produtoId: number
}

type State = 'idle' | 'loading' | 'success' | 'error'

export function NuvemshopSendButton({ produtoId }: Props) {
  const [state, setState]           = useState<State>('idle')
  const [externalId, setExternalId] = useState<string | null>(null)
  const [skipped, setSkipped]       = useState(false)

  async function handleSend() {
    setState('loading')
    try {
      const res  = await fetch('/api/integrations/nuvemshop/product', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ produto_id: produtoId }),
      })
      const data = await res.json()

      if (res.ok && data.ok) {
        setExternalId(data.external_id)
        setSkipped(!!data.skipped)
        setState('success')
      } else {
        setState('error')
      }
    } catch {
      setState('error')
    }
  }

  if (state === 'success') {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-green-600">
        <Send className="h-3.5 w-3.5" />
        {skipped ? 'Já enviado' : 'Enviado'}{externalId ? ` · ID ${externalId}` : ''}
      </span>
    )
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleSend}
      disabled={state === 'loading'}
    >
      <Send className="mr-2 h-4 w-4" />
      {state === 'loading'
        ? 'Enviando...'
        : state === 'error'
        ? 'Tentar novamente'
        : 'Enviar para Nuvemshop'}
    </Button>
  )
}
