'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

interface AuthorizationModalProps {
  open:            boolean
  action:          string
  title:           string
  description:     string
  resourceType?:   string
  resourceId?:     string
  reasonRequired?: boolean
  /** Para approve_discount: percentual e valor a gravar no token */
  discountPct?:    number
  discountAmount?: number
  onAuthorized:    (tokenId: string) => void
  onCancel:        () => void
}

export function AuthorizationModal({
  open,
  action,
  title,
  description,
  resourceType,
  resourceId,
  reasonRequired = false,
  discountPct,
  discountAmount,
  onAuthorized,
  onCancel,
}: AuthorizationModalProps) {
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [reason, setReason]     = useState('')
  const [loading, setLoading]   = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password) {
      toast.error('Informe o email e senha do gerente.')
      return
    }
    if (reasonRequired && !reason.trim()) {
      toast.error('Motivo é obrigatório para esta ação.')
      return
    }

    setLoading(true)
    try {
      const res = await fetch('/api/auth/authorize', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          email,
          password,
          action,
          resource_type:   resourceType,
          resource_id:     resourceId,
          reason:          reason.trim() || undefined,
          discount_pct:    discountPct,
          discount_amount: discountAmount,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        const msg = typeof json.error === 'string' ? json.error : 'Erro ao autorizar.'
        toast.error(msg)
        return
      }
      toast.success('Autorizado com sucesso.')
      setEmail('')
      setPassword('')
      setReason('')
      onAuthorized(json.token_id)
    } catch {
      toast.error('Erro ao contactar o servidor.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onClose={onCancel} title={title} description={description} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4 mt-4">
        <Input
          label="Email do gerente"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
          required
        />
        <Input
          label="Senha do gerente"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
        />
        <Input
          label={reasonRequired ? 'Motivo *' : 'Motivo (opcional)'}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Ex.: cliente fidelizada, liquidação..."
        />
        <div className="flex gap-3 pt-1">
          <Button type="button" variant="secondary" onClick={onCancel} className="flex-1">
            Cancelar
          </Button>
          <Button type="submit" loading={loading} className="flex-1">
            Autorizar
          </Button>
        </div>
      </form>
    </Modal>
  )
}
