'use client'

import { cn } from '@/lib/utils/cn'
import { formatRelative } from '@/lib/utils/date'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import type { CrmChannelOption } from './inbox'

// Espelha o contrato JSON de GET /api/crm/conversations.
export interface ConversationListItem {
  id: number
  channel_id: number
  channel_identity_id: number
  person_id: number
  status: 'open' | 'pending' | 'closed'
  last_message_at: string | null
  created_at: string
  person: { id: number; display_name: string } | null
  channel: { id: number; name: string; channel_type: string } | null
  last_message: {
    content: string | null
    content_type: string
    direction: 'inbound' | 'outbound'
    status: string
    created_at: string
  } | null
}

const CONVERSATION_STATUS_LABEL: Record<string, string> = {
  open: 'Aberta',
  pending: 'Pendente',
  closed: 'Encerrada',
}

const CONVERSATION_STATUS_VARIANT: Record<string, 'success' | 'warning' | 'default'> = {
  open: 'success',
  pending: 'warning',
  closed: 'default',
}

function previewText(lastMessage: ConversationListItem['last_message']): string {
  if (!lastMessage) return 'Sem mensagens'
  if (lastMessage.content) return lastMessage.content
  const labels: Record<string, string> = {
    image: '📷 Imagem', audio: '🎵 Áudio', video: '🎬 Vídeo',
    document: '📄 Documento', location: '📍 Localização', contact: '👤 Contato', other: 'Anexo',
  }
  return labels[lastMessage.content_type] ?? 'Mensagem'
}

interface ConversationListProps {
  conversations: ConversationListItem[]
  loading: boolean
  hasMore: boolean
  channels: CrmChannelOption[]
  statusFilter: string
  channelFilter: string
  onStatusFilterChange: (value: string) => void
  onChannelFilterChange: (value: string) => void
  selectedConversationId: number | null
  onSelect: (id: number) => void
}

export function ConversationList({
  conversations,
  loading,
  hasMore,
  channels,
  statusFilter,
  channelFilter,
  onStatusFilterChange,
  onChannelFilterChange,
  selectedConversationId,
  onSelect,
}: ConversationListProps) {
  // DEBUG temporário (Entrega 7) — remover depois de localizar o bug.
  // Sem useMemo/filtro/sort neste componente: `conversations` é renderizado
  // exatamente como chega via prop, sem transformação intermediária nenhuma.
  console.log('[DEBUG] render conversations', conversations)

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-border flex flex-col gap-2">
        <Select
          value={statusFilter}
          onChange={(e) => onStatusFilterChange(e.target.value)}
          className="text-sm"
        >
          <option value="">Todos os status</option>
          <option value="open">Abertas</option>
          <option value="pending">Pendentes</option>
          <option value="closed">Encerradas</option>
        </Select>
        <Select
          value={channelFilter}
          onChange={(e) => onChannelFilterChange(e.target.value)}
          className="text-sm"
        >
          <option value="">Todos os canais</option>
          {channels.map((channel) => (
            <option key={channel.id} value={channel.id}>{channel.name}</option>
          ))}
        </Select>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && conversations.length === 0 && (
          <div className="flex items-center justify-center p-8">
            <Spinner size="sm" />
          </div>
        )}

        {!loading && conversations.length === 0 && (
          <p className="text-sm text-text-muted text-center p-8">Nenhuma conversa encontrada.</p>
        )}

        {/* DEBUG temporário (Entrega 7) — remover depois de localizar o bug. */}
        {console.log('[DEBUG] map length', conversations.length) as unknown as null}

        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            onClick={() => onSelect(conversation.id)}
            className={cn(
              'w-full text-left px-3 py-3 border-b border-border hover:bg-bg-overlay transition-colors',
              selectedConversationId === conversation.id && 'bg-bg-overlay',
            )}
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-sm font-medium text-text-primary truncate">
                {conversation.person?.display_name ?? 'Pessoa desconhecida'}
              </span>
              {conversation.last_message_at && (
                <span className="text-xs text-text-muted flex-shrink-0">
                  {formatRelative(conversation.last_message_at)}
                </span>
              )}
            </div>

            <p className="text-xs text-text-secondary truncate mb-1.5">
              {conversation.last_message?.direction === 'outbound' && 'Você: '}
              {previewText(conversation.last_message)}
            </p>

            <div className="flex items-center gap-1.5">
              <Badge variant={CONVERSATION_STATUS_VARIANT[conversation.status] ?? 'default'} size="sm">
                {CONVERSATION_STATUS_LABEL[conversation.status] ?? conversation.status}
              </Badge>
              {conversation.channel && (
                <Badge variant="outline" size="sm">{conversation.channel.name}</Badge>
              )}
            </div>
          </button>
        ))}

        {hasMore && !loading && (
          <p className="text-xs text-text-muted text-center p-3">
            Mais conversas disponíveis — refine os filtros para ver outras.
          </p>
        )}
      </div>
    </div>
  )
}
