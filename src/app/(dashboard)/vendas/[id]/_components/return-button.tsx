'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AuthorizationModal } from '@/components/auth/AuthorizationModal'

interface Props {
  saleId:       number
  requiresAuth: boolean
}

export function ReturnButton({ saleId, requiresAuth }: Props) {
  const router = useRouter()
  const [loading, setLoading]   = useState(false)
  const [showModal, setShowModal] = useState(false)

  async function doReturn(tokenId?: string) {
    setLoading(true)
    try {
      const res = await fetch(`/api/vendas/${saleId}/devolucao`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ authorization_token_id: tokenId }),
      })
      if (!res.ok) {
        const err = await res.json()
        toast.error('Erro ao registrar devolução', { description: err.error })
        return
      }
      toast.success('Devolução registrada com sucesso')
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  function handleClick() {
    if (requiresAuth) {
      setShowModal(true)
    } else {
      if (!confirm('Confirmar devolução desta venda? O estoque dos itens será restaurado automaticamente.')) return
      doReturn()
    }
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={handleClick} loading={loading}>
        <RotateCcw className="w-3.5 h-3.5" />
        Registrar Devolução
      </Button>

      <AuthorizationModal
        open={showModal}
        action="return_sale"
        title="Autorizar devolução"
        description="Esta ação requer aprovação de gerente. Informe as credenciais de um gerente ou administrador."
        resourceType="sale"
        resourceId={String(saleId)}
        reasonRequired={false}
        onAuthorized={(tokenId) => {
          setShowModal(false)
          doReturn(tokenId)
        }}
        onCancel={() => setShowModal(false)}
      />
    </>
  )
}
