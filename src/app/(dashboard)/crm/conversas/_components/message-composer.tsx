'use client'

import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Paperclip, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

// mime real -> content_type do modelo de crm_messages (Entregas 2/4/6) —
// mesmo mapeamento conceitual já usado no inbound, aqui do lado outbound.
function contentTypeForMime(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  return 'document'
}

export function MessageComposer({
  conversationId,
  onSent,
}: {
  conversationId: number
  onSent: () => void
}) {
  const [text, setText] = useState('')
  const [attachedFile, setAttachedFile] = useState<File | null>(null)
  const [sending, setSending] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const canSend = (text.trim().length > 0 || attachedFile !== null) && !sending

  async function handleSend() {
    if (!canSend) return
    setSending(true)

    try {
      let mediaPublicId: string | null = null
      let contentType = 'text'

      // Upload primeiro, SEPARADO do envio — nunca base64 no corpo do envio
      // outbound (decisão já tomada na Entrega 6). POST /api/media já é
      // acessível a qualquer usuário autenticado, sem mudança nenhuma aqui.
      if (attachedFile) {
        const formData = new FormData()
        formData.append('file', attachedFile)
        formData.append('visibility', 'private')

        const uploadRes = await fetch('/api/media', { method: 'POST', body: formData })
        const uploadJson = await uploadRes.json()

        if (!uploadRes.ok) {
          toast.error('Erro ao enviar anexo', { description: uploadJson.error })
          setSending(false)
          return
        }

        mediaPublicId = uploadJson.media.public_id
        contentType = contentTypeForMime(attachedFile.type)
      }

      const clientDedupeKey = crypto.randomUUID()

      const sendRes = await fetch(`/api/crm/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: text.trim() || undefined,
          content_type: contentType,
          media_public_id: mediaPublicId ?? undefined,
          client_dedupe_key: clientDedupeKey,
        }),
      })
      const sendJson = await sendRes.json()

      if (!sendRes.ok) {
        toast.error('Erro ao enviar mensagem', { description: sendJson.error })
        return
      }

      // provider_error/status_update_error sempre presentes no corpo desde a
      // correção da Entrega 6 — nunca ficam invisíveis, mesmo com HTTP 200/201.
      if (sendJson.provider_error) {
        toast.error('Mensagem criada, mas o envio falhou', { description: sendJson.provider_error })
      } else if (sendJson.status_update_error) {
        toast.warning('Mensagem enviada, mas houve erro ao registrar o status', { description: sendJson.status_update_error })
      }

      setText('')
      setAttachedFile(null)
      onSent()
    } catch {
      toast.error('Erro de rede ao enviar mensagem')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="border-t border-border p-3">
      {attachedFile && (
        <div className="flex items-center gap-2 mb-2 text-xs text-text-secondary bg-bg-overlay rounded-lg px-2 py-1.5 w-fit">
          <Paperclip className="w-3.5 h-3.5" />
          <span className="truncate max-w-[200px]">{attachedFile.name}</span>
          <button type="button" onClick={() => setAttachedFile(null)} className="text-text-muted hover:text-error">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => setAttachedFile(e.target.files?.[0] ?? null)}
        />
        <Button
          type="button"
          variant="secondary"
          size="icon"
          onClick={() => fileInputRef.current?.click()}
          disabled={sending}
        >
          <Paperclip className="w-4 h-4" />
        </Button>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          placeholder="Escreva uma mensagem..."
          rows={1}
          disabled={sending}
          className="flex-1 resize-none rounded-xl border border-border bg-bg-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand disabled:opacity-60"
        />

        <Button type="button" onClick={handleSend} disabled={!canSend} className="flex-shrink-0">
          <Send className="w-4 h-4" />
        </Button>
      </div>
    </div>
  )
}
