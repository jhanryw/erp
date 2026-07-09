'use client'

import { useCallback, useEffect, useState } from 'react'
import { MessageSquare } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { Spinner } from '@/components/ui/spinner'
import { ConversationList, type ConversationListItem } from './conversation-list'
import { ConversationThread } from './conversation-thread'

// Espelha o contrato JSON de GET /api/crm/channels — tipo local, mesmo
// padrão do resto do projeto (ex.: product-media.tsx) de não importar tipo
// de backend em Client Component.
export interface CrmChannelOption {
  id: number
  name: string
  channel_type: string
}

export function Inbox() {
  const [conversations, setConversations] = useState<ConversationListItem[]>([])
  const [channels, setChannels] = useState<CrmChannelOption[]>([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)

  const [statusFilter, setStatusFilter] = useState<string>('')
  const [channelFilter, setChannelFilter] = useState<string>('')

  const [selectedConversationId, setSelectedConversationId] = useState<number | null>(null)

  const loadConversations = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (statusFilter) params.set('status', statusFilter)
      if (channelFilter) params.set('channel_id', channelFilter)

      const res = await fetch(`/api/crm/conversations?${params.toString()}`)
      const json = await res.json()

      // DEBUG temporário (Entrega 7) — remover depois de localizar o bug.
      console.log('[DEBUG] API conversations', json.conversations)

      const nextConversations = res.ok ? (json.conversations ?? []) : []

      // DEBUG temporário (Entrega 7) — remover depois de localizar o bug.
      console.log('[DEBUG] setConversations', nextConversations.length)

      setConversations(nextConversations)
      setHasMore(res.ok ? Boolean(json.has_more) : false)
    } catch (err) {
      // DEBUG temporário (Entrega 7) — antes este catch era mudo, por isso
      // uma falha de parse/rede nunca aparecia em lugar nenhum.
      console.error('[DEBUG] loadConversations() caiu no catch', err)
      setConversations([])
    } finally {
      setLoading(false)
    }
  }, [statusFilter, channelFilter])

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  useEffect(() => {
    fetch('/api/crm/channels')
      .then((res) => res.json())
      .then((json) => setChannels(json.channels ?? []))
      .catch(() => setChannels([]))
  }, [])

  // Sem realtime nesta entrega (decisão explícita) — enviar/receber atualiza
  // a lista por chamada direta, não por assinatura em background.
  function handleMessageSent() {
    loadConversations()
  }

  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-xl font-semibold text-text-primary mb-1">CRM — Conversas</h1>

      <div className="flex h-[calc(100vh-160px)] min-h-[500px] gap-4">
        <div className="w-[360px] flex-shrink-0 flex flex-col card overflow-hidden">
          <ConversationList
            conversations={conversations}
            loading={loading}
            hasMore={hasMore}
            channels={channels}
            statusFilter={statusFilter}
            channelFilter={channelFilter}
            onStatusFilterChange={setStatusFilter}
            onChannelFilterChange={setChannelFilter}
            selectedConversationId={selectedConversationId}
            onSelect={setSelectedConversationId}
          />
        </div>

        <div className="flex-1 card overflow-hidden flex flex-col">
          {selectedConversationId === null ? (
            <EmptyState
              icon={<MessageSquare className="w-6 h-6" />}
              title="Selecione uma conversa"
              description="Escolha uma conversa na lista ao lado para ver as mensagens."
            />
          ) : (
            <ConversationThread
              conversationId={selectedConversationId}
              onMessageSent={handleMessageSent}
            />
          )}
        </div>
      </div>

      {loading && conversations.length === 0 && (
        <div className="fixed bottom-6 right-6">
          <Spinner size="sm" />
        </div>
      )}
    </div>
  )
}
