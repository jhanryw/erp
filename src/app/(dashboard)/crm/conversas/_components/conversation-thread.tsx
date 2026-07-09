'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, FileText, MapPin, Phone, Reply, User as UserIcon,
  Check, CheckCheck, Clock, AlertCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { formatDateTime, formatDayLabel } from '@/lib/utils/date'
import { formatFileSize } from '@/lib/utils/file-size'
import { Spinner } from '@/components/ui/spinner'
import { MessageComposer } from './message-composer'

// Espelha o contrato JSON de GET /api/crm/conversations/[id]/messages —
// CrmMessage é linha direta do banco (já snake_case), media vem resolvida
// em lote por listMediaByEntities() (Entrega 4) com o mesmo shape de
// ResolvedMediaUsageWithEntity (media.service.ts) — extension/file_size/
// alt_text já vinham na resposta desde a Entrega 4, só não eram lidos
// até a Entrega 8 (Thread + Composer).
interface MessageMedia {
  usage_id: number
  public_id: string
  role: string
  mime_type: string
  url: string
  extension: string | null
  file_size: number
  alt_text: string | null
}

interface Message {
  id: number
  direction: 'inbound' | 'outbound'
  status: 'received' | 'pending' | 'sent' | 'delivered' | 'read' | 'failed'
  content: string | null
  content_type: string
  metadata: Record<string, unknown> | null
  failure_reason: string | null
  created_at: string
  reply_to_message_id: number | null
  media: MessageMedia[]
}

interface ConversationDetail {
  conversation: { id: number; status: string }
  person: { id: number; display_name: string } | null
  channel: { id: number; name: string; channel_type: string } | null
  channel_identity: { id: number; value: string } | null
}

function StatusIcon({ status }: { status: Message['status'] }) {
  switch (status) {
    case 'pending': return <Clock className="w-3.5 h-3.5 text-text-muted" />
    case 'sent': return <Check className="w-3.5 h-3.5 text-text-muted" />
    case 'delivered': return <CheckCheck className="w-3.5 h-3.5 text-text-muted" />
    case 'read': return <CheckCheck className="w-3.5 h-3.5 text-info" />
    case 'failed': return <AlertCircle className="w-3.5 h-3.5 text-error" />
    default: return null
  }
}

// content_type agnóstico a canal — nenhum campo aqui é específico de
// WhatsApp/Evolution, só convenções de nome de campo em `metadata`
// (aprovadas pelo usuário na Entrega 8: latitude/longitude/address pra
// location, name/phone pra contact). Sempre com fallback genérico quando
// os campos não existem — nada quebra se um canal futuro não os preencher.
function MessageLocation({ metadata }: { metadata: Message['metadata'] }) {
  const latitude = typeof metadata?.latitude === 'number' ? metadata.latitude : null
  const longitude = typeof metadata?.longitude === 'number' ? metadata.longitude : null
  const address = typeof metadata?.address === 'string' ? metadata.address : null

  if (latitude === null || longitude === null) {
    return (
      <p className="text-xs flex items-center gap-1.5 mb-1">
        <MapPin className="w-3.5 h-3.5 flex-shrink-0" /> Localização compartilhada
      </p>
    )
  }

  return (
    <a
      href={`https://www.google.com/maps?q=${latitude},${longitude}`}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1.5 text-xs underline mb-1"
    >
      <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
      {address ?? `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`}
    </a>
  )
}

function MessageContact({ metadata }: { metadata: Message['metadata'] }) {
  const name = typeof metadata?.name === 'string' ? metadata.name : null
  const phone = typeof metadata?.phone === 'string' ? metadata.phone : null

  if (!name && !phone) {
    return (
      <p className="text-xs flex items-center gap-1.5 mb-1">
        <Phone className="w-3.5 h-3.5 flex-shrink-0" /> Contato compartilhado
      </p>
    )
  }

  return (
    <p className="text-xs flex items-center gap-1.5 mb-1">
      <Phone className="w-3.5 h-3.5 flex-shrink-0" />
      {name ?? 'Contato'}{phone ? ` · ${phone}` : ''}
    </p>
  )
}

function MessageAttachment({ media }: { media: MessageMedia }) {
  if (media.mime_type.startsWith('image/')) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={media.url} alt={media.alt_text ?? 'Anexo'} className="max-w-[240px] rounded-lg mb-1.5" />
  }

  if (media.mime_type.startsWith('video/')) {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <video controls src={media.url} className="max-w-[280px] rounded-lg mb-1.5" />
    )
  }

  if (media.mime_type.startsWith('audio/')) {
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <audio controls src={media.url} className="mb-1.5 max-w-[240px] w-full" />
  }

  const fileLabel = media.alt_text || `Documento${media.extension ? `.${media.extension}` : ''}`
  return (
    <a
      href={media.url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 text-xs underline mb-1.5"
    >
      <FileText className="w-4 h-4 flex-shrink-0" />
      <span className="truncate max-w-[180px]">{fileLabel}</span>
      <span className="opacity-70 flex-shrink-0">({formatFileSize(media.file_size)})</span>
    </a>
  )
}

export function ConversationThread({
  conversationId,
  onMessageSent,
  onBack,
}: {
  conversationId: number
  onMessageSent: () => void
  onBack: () => void
}) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const loadThread = useCallback(async () => {
    setLoading(true)
    try {
      const [detailRes, messagesRes] = await Promise.all([
        fetch(`/api/crm/conversations/${conversationId}`),
        fetch(`/api/crm/conversations/${conversationId}/messages`),
      ])
      const detailJson = await detailRes.json()
      const messagesJson = await messagesRes.json()

      setDetail(detailRes.ok ? detailJson : null)
      setMessages(messagesRes.ok ? (messagesJson.messages ?? []) : [])
    } catch {
      setDetail(null)
      setMessages([])
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  useEffect(() => {
    loadThread()
  }, [loadThread])

  // Abre sempre na última mensagem, e volta pro fim após qualquer recarga
  // (inclusive após enviar) — sem realtime/polling, só reage à mudança de
  // `messages` que já acontece por fetch direto (loadThread()).
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, loading])

  // Só pra exibir "Respondendo: ..." (Entrega 8 — preparação de reply, sem
  // implementar a interação de escolher uma mensagem pra responder). Se a
  // mensagem original não estiver na página carregada (>50 mensagens atrás),
  // não busca de novo — mostra só o indicador sem o trecho citado.
  const messagesById = useMemo(() => {
    const map = new Map<number, Message>()
    for (const message of messages) map.set(message.id, message)
    return map
  }, [messages])

  const groupedMessages = useMemo(() => {
    const groups: Array<{ label: string; items: Message[] }> = []
    for (const message of messages) {
      const label = formatDayLabel(message.created_at)
      const lastGroup = groups[groups.length - 1]
      if (lastGroup && lastGroup.label === label) {
        lastGroup.items.push(message)
      } else {
        groups.push({ label, items: [message] })
      }
    }
    return groups
  }, [messages])

  function handleSent() {
    loadThread()
    onMessageSent()
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Voltar para a lista"
          className="lg:hidden flex-shrink-0 p-1 -ml-1 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="w-8 h-8 rounded-full bg-bg-overlay flex items-center justify-center flex-shrink-0">
          <UserIcon className="w-4 h-4 text-text-secondary" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary truncate">
            {detail?.person?.display_name ?? (loading ? 'Carregando...' : 'Pessoa desconhecida')}
          </p>
          <p className="text-xs text-text-muted truncate">
            {detail?.channel?.name ?? ''}{detail?.channel_identity ? ` · ${detail.channel_identity.value}` : ''}
          </p>
        </div>
      </div>

      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
        {loading && (
          <div className="flex items-center justify-center flex-1">
            <Spinner size="sm" />
          </div>
        )}

        {!loading && messages.length === 0 && (
          <p className="text-sm text-text-muted text-center mt-8">Nenhuma mensagem ainda.</p>
        )}

        {groupedMessages.map((group) => (
          <div key={`${group.label}-${group.items[0].id}`} className="flex flex-col gap-2">
            <div className="flex items-center justify-center my-1">
              <span className="text-[10px] font-medium text-text-muted bg-bg-overlay px-2.5 py-1 rounded-full">
                {group.label}
              </span>
            </div>

            {group.items.map((message) => {
              const repliedTo = message.reply_to_message_id ? messagesById.get(message.reply_to_message_id) : null
              const isOutbound = message.direction === 'outbound'

              return (
                <div key={message.id} className={cn('flex', isOutbound ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'max-w-[70%] rounded-2xl px-3 py-2',
                      isOutbound
                        ? 'bg-brand text-white rounded-br-sm'
                        : 'bg-bg-overlay text-text-primary rounded-bl-sm',
                    )}
                  >
                    {repliedTo && (
                      <div
                        className={cn(
                          'flex items-center gap-1 text-[10px] mb-1.5 pb-1.5 border-b',
                          isOutbound ? 'border-white/20 text-white/70' : 'border-border text-text-muted',
                        )}
                      >
                        <Reply className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{repliedTo.content || 'Anexo'}</span>
                      </div>
                    )}

                    {message.media.map((media) => (
                      <MessageAttachment key={media.usage_id} media={media} />
                    ))}

                    {message.content_type === 'location' && <MessageLocation metadata={message.metadata} />}
                    {message.content_type === 'contact' && <MessageContact metadata={message.metadata} />}

                    {message.content && <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>}

                    <div className="flex items-center justify-end gap-1 mt-1">
                      <span className={cn('text-[10px]', isOutbound ? 'text-white/70' : 'text-text-muted')}>
                        {formatDateTime(message.created_at)}
                      </span>
                      {isOutbound && <StatusIcon status={message.status} />}
                    </div>

                    {message.status === 'failed' && message.failure_reason && (
                      <p className="text-[10px] text-error mt-0.5">{message.failure_reason}</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>

      <MessageComposer conversationId={conversationId} onSent={handleSent} />
    </div>
  )
}
