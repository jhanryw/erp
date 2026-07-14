'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { FileText, Music, Paperclip, Send, Video, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatFileSize } from '@/lib/utils/file-size'

// mime real -> content_type do modelo de crm_messages (Entregas 2/4/6) —
// mesmo mapeamento conceitual já usado no inbound, aqui do lado outbound.
// image/webp é o formato de sticker do WhatsApp — sem este branch, todo
// sticker enviado pelo composer virava content_type 'image' (achado da
// auditoria da Parte B: outbound sticker existia no schema/banco desde a
// Entrega 2, mas nunca tinha caminho completo até aqui).
function contentTypeForMime(mimeType: string): string {
  if (mimeType === 'image/webp') return 'sticker'
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  return 'document'
}

/** Já foi feito upload deste anexo com sucesso — reenvio após falha do POST de
 *  mensagem reaproveita o mesmo public_id em vez de subir o arquivo de novo
 *  (achado da auditoria da Entrega 8: sem isso, cada retry criava um registro
 *  órfão novo em `media`). */
interface UploadedMedia {
  publicId: string
  contentType: string
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
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [uploadedMedia, setUploadedMedia] = useState<UploadedMedia | null>(null)
  const [sending, setSending] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const canSend = (text.trim().length > 0 || attachedFile !== null) && !sending

  // Preview de imagem antes do envio — só gera object URL pra imagem (é o
  // único tipo que vale a pena prévia visual aqui); outros tipos mostram
  // ícone + nome + tamanho. Revoga sempre que o arquivo muda ou o composer desmonta.
  useEffect(() => {
    if (!attachedFile || !attachedFile.type.startsWith('image/')) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(attachedFile)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [attachedFile])

  function handleAttach(file: File | null) {
    setAttachedFile(file)
    setUploadedMedia(null) // arquivo novo — upload anterior (se houver) não vale mais
  }

  function handleRemoveAttachment() {
    setAttachedFile(null)
    setUploadedMedia(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handleSend() {
    if (!canSend) return
    setSending(true)

    try {
      let mediaPublicId: string | null = null
      let contentType = 'text'

      if (attachedFile) {
        contentType = contentTypeForMime(attachedFile.type)

        if (uploadedMedia) {
          // Retry após falha anterior no envio da mensagem — anexo já está
          // no Media Hub, não sobe de novo.
          mediaPublicId = uploadedMedia.publicId
        } else {
          // Upload primeiro, SEPARADO do envio — nunca base64 no corpo do
          // envio outbound (decisão já tomada na Entrega 6). POST /api/media
          // já é acessível a qualquer usuário autenticado, sem mudança
          // nenhuma aqui.
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
          setUploadedMedia({ publicId: mediaPublicId!, contentType })
        }
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
      handleRemoveAttachment()
      onSent()
    } catch {
      toast.error('Erro de rede ao enviar mensagem')
    } finally {
      setSending(false)
    }
  }

  const attachmentIcon = attachedFile?.type.startsWith('video/')
    ? Video
    : attachedFile?.type.startsWith('audio/')
      ? Music
      : FileText
  const AttachmentIcon = attachmentIcon

  return (
    <div className="border-t border-border p-3">
      {attachedFile && (
        <div className="flex items-center gap-2 mb-2 text-xs text-text-secondary bg-bg-overlay rounded-lg px-2 py-1.5 w-fit max-w-full">
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt="Preview do anexo" className="w-10 h-10 object-cover rounded-md flex-shrink-0" />
          ) : (
            <AttachmentIcon className="w-3.5 h-3.5 flex-shrink-0" />
          )}
          <span className="truncate max-w-[180px]">{attachedFile.name}</span>
          <span className="text-text-muted flex-shrink-0">({formatFileSize(attachedFile.size)})</span>
          <button
            type="button"
            onClick={handleRemoveAttachment}
            disabled={sending}
            aria-label="Remover anexo"
            className="text-text-muted hover:text-error disabled:opacity-50 disabled:pointer-events-none flex-shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => handleAttach(e.target.files?.[0] ?? null)}
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

        <Button type="button" onClick={handleSend} disabled={!canSend} loading={sending} className="flex-shrink-0">
          {!sending && <Send className="w-4 h-4" />}
        </Button>
      </div>
    </div>
  )
}
