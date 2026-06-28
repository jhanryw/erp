'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AuthorizationModal } from '@/components/auth/AuthorizationModal'

interface Props {
  saleId:       number
  requiresAuth: boolean
}

export function CancelSaleButton({ saleId, requiresAuth }: Props) {
  const router = useRouter()
  const [loading, setLoading]   = useState(false)
  const [showModal, setShowModal] = useState(false)

  async function doCancel(tokenId?: string) {
    setLoading(true)
    try {
      const res = await fetch(`/api/vendas/${saleId}/cancelar`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ authorization_token_id: tokenId }),
      })
      if (!res.ok) {
        const err = await res.json()
        toast.error('Erro ao cancelar venda', { description: err.error })
        return
      }
      toast.success('Venda cancelada com sucesso')
      router.refresh()
    } catch {
      toast.error('Erro ao cancelar venda', { description: 'Não foi possível concluir o cancelamento.' })
    } finally {
      setLoading(false)
    }
  }

  function handleClick() {
    if (requiresAuth) {
      setShowModal(true)
    } else {
      if (!confirm('Cancelar esta venda? O status será alterado para Cancelado e o estoque será restaurado automaticamente.')) return
      doCancel()
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={handleClick}
        loading={loading}
        className="text-error border-error/30 hover:bg-error/10 hover:border-error/50"
      >
        <XCircle className="w-3.5 h-3.5" />
        Cancelar Venda
      </Button>

      <AuthorizationModal
        open={showModal}
        action="cancel_sale"
        title="Autorizar cancelamento"
        description="Esta ação requer aprovação de gerente. Informe as credenciais de um gerente ou administrador."
        resourceType="sale"
        resourceId={String(saleId)}
        reasonRequired={false}
        onAuthorized={(tokenId) => {
          setShowModal(false)
          doCancel(tokenId)
        }}
        onCancel={() => setShowModal(false)}
      />
    </>
  )
}
