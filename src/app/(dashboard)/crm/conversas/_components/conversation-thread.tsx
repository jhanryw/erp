'use client'

import { useCallback, useEffect, useState } from 'react'
import { FileText, MapPin, User as UserIcon, Check, CheckCheck, Clock, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { formatDateTime } from '@/lib/utils/date'
import { Spinner } from '@/components/ui/spinner'
import { Badge } from '@/components/ui/badge'
import { MessageComposer } from './message-composer'

// Espelha o contrato JSON de GET /api/crm/conversations/[id]/messages —
// CrmMessage é linha direta do banco (já snake_case), media vem resolvida
// em lote por listMediaByEntities().
interface MessageMedia {
  usage_id: number
  public_id: string
  role: string
  mime_type: string
  url: string
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

function MessageAttachment({ media }: { media: MessageMedia }) {
  if (media.mime_type.startsWith('image/')) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={media.url} alt="Anexo" className="max-w-[240px] rounded-lg mb-1.5" />
  }
  return (
    <a
      href={media.url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 text-xs underline mb-1.5"
    >
      <FileText className="w-4 h-4 flex-shrink-0" />
      Anexo ({media.mime_type})
    </a>
  )
}

export function ConversationThread({
  conversationId,
  onMessageSent,
}: {
  conversationId: number
  onMessageSent: () => void
}) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)

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

  function handleSent() {
    loadThread()
    onMessageSent()
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
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

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
        {loading && (
          <div className="flex items-center justify-center flex-1">
            <Spinner size="sm" />
          </div>
        )}

        {!loading && messages.length === 0 && (
          <p className="text-sm text-text-muted text-center mt-8">Nenhuma mensagem ainda.</p>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={cn('flex', message.direction === 'outbound' ? 'justify-end' : 'justify-start')}
          >
            <div
              className={cn(
                'max-w-[70%] rounded-2xl px-3 py-2',
                message.direction === 'outbound'
                  ? 'bg-brand text-white rounded-br-sm'
                  : 'bg-bg-overlay text-text-primary rounded-bl-sm',
              )}
            >
              {message.media.map((media) => (
                <MessageAttachment key={media.usage_id} media={media} />
              ))}

              {message.content_type === 'location' && (
                <p className="text-xs flex items-center gap-1 mb-1">
                  <MapPin className="w-3.5 h-3.5" /> Localização compartilhada
                </p>
              )}

              {message.content && <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>}

              <div className="flex items-center justify-end gap-1 mt-1">
                <span className={cn('text-[10px]', message.direction === 'outbound' ? 'text-white/70' : 'text-text-muted')}>
                  {formatDateTime(message.created_at)}
                </span>
                {message.direction === 'outbound' && <StatusIcon status={message.status} />}
              </div>

              {message.status === 'failed' && message.failure_reason && (
                <p className="text-[10px] text-error mt-0.5">{message.failure_reason}</p>
              )}
            </div>
          </div>
        ))}
      </div>

      <MessageComposer conversationId={conversationId} onSent={handleSent} />
    </div>
  )
}
