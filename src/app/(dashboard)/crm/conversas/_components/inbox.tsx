'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
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

// Espelha o contrato JSON de GET /api/crm/conversations/counts (Entrega 9).
export interface ConversationCounts {
  open: number
  pending: number
  closed: number
}

const SEARCH_DEBOUNCE_MS = 400

export function Inbox() {
  const [conversations, setConversations] = useState<ConversationListItem[]>([])
  const [channels, setChannels] = useState<CrmChannelOption[]>([])
  const [counts, setCounts] = useState<ConversationCounts | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [channelFilter, setChannelFilter] = useState<string>('')

  const [selectedConversationId, setSelectedConversationId] = useState<number | null>(null)

  // Debounce simples — evita 1 requisição por tecla digitada na busca.
  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timeout)
  }, [search])

  // Compartilhado entre a busca "do zero" e o "carregar mais" — mesmos
  // filtros, só o offset muda.
  const buildParams = useCallback((offset?: number) => {
    const params = new URLSearchParams()
    if (statusFilter) params.set('status', statusFilter)
    if (channelFilter) params.set('channel_id', channelFilter)
    if (debouncedSearch) params.set('search', debouncedSearch)
    if (offset) params.set('offset', String(offset))
    return params
  }, [statusFilter, channelFilter, debouncedSearch])

  // Busca do zero — sempre offset 0, sempre SUBSTITUI a lista. Chamada no
  // mount e sempre que filtro/busca muda (via useEffect abaixo), o que já
  // reseta a paginação pra página 1 de graça, sem lógica extra.
  const loadConversations = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/crm/conversations?${buildParams().toString()}`)
      const json = await res.json()

      // Antes desta correção, falha de API (ex.: RPC de busca ausente/erro
      // no banco) virava lista vazia sem nenhum sinal — indistinguível de
      // "nenhum resultado" pra quem está atendendo. Erro sempre visível
      // agora, nunca só um array vazio silencioso.
      if (!res.ok) {
        toast.error('Erro ao carregar conversas', { description: json.error })
        setConversations([])
        setHasMore(false)
        return
      }

      setConversations(json.conversations ?? [])
      setHasMore(Boolean(json.has_more))
    } catch {
      toast.error('Erro de rede ao carregar conversas')
      setConversations([])
    } finally {
      setLoading(false)
    }
  }, [buildParams])

  // "Carregar mais" — ACRESCENTA à lista existente, offset = quantidade já
  // carregada (sempre múltiplo de `limit`, então nunca pula/repete página).
  // Paginação por offset simples (sem cursor) — decisão explícita: uma
  // conversa pode mudar de posição entre páginas se receber mensagem nova
  // no meio da navegação (last_message_at muda a ordenação); risco aceito
  // nesta entrega, cursor pagination fica pra outra.
  const loadMoreConversations = useCallback(async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const res = await fetch(`/api/crm/conversations?${buildParams(conversations.length).toString()}`)
      const json = await res.json()

      if (!res.ok) {
        toast.error('Erro ao carregar mais conversas', { description: json.error })
        return
      }

      setConversations((prev) => [...prev, ...(json.conversations ?? [])])
      setHasMore(Boolean(json.has_more))
    } catch {
      toast.error('Erro de rede ao carregar mais conversas')
    } finally {
      setLoadingMore(false)
    }
  }, [buildParams, conversations.length, hasMore, loadingMore])

  const loadCounts = useCallback(async () => {
    try {
      const res = await fetch('/api/crm/conversations/counts')
      const json = await res.json()
      setCounts(res.ok ? json.counts : null)
    } catch {
      setCounts(null)
    }
  }, [])

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  useEffect(() => {
    loadCounts()
  }, [loadCounts])

  useEffect(() => {
    fetch('/api/crm/channels')
      .then((res) => res.json())
      .then((json) => setChannels(json.channels ?? []))
      .catch(() => setChannels([]))
  }, [])

  // Sem realtime nesta entrega (decisão explícita) — enviar/receber, mudar
  // status ou atualizar manualmente refazem a busca por chamada direta, não
  // por assinatura em background. Contadores recarregam junto porque uma
  // mudança de status desloca o total entre as 3 colunas.
  function handleMessageSent() {
    loadConversations()
    loadCounts()
  }

  function handleStatusChanged() {
    loadConversations()
    loadCounts()
  }

  function handleRefresh() {
    loadConversations()
    loadCounts()
  }

  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-xl font-semibold text-text-primary mb-1">CRM — Conversas</h1>

      <div className="flex h-[calc(100vh-160px)] min-h-[500px] gap-4">
        {/* Mobile/tablet (<lg): tela única — lista OU thread, nunca as duas.
            Desktop (lg+): sempre as duas colunas lado a lado. */}
        <div
          className={cn(
            'w-full lg:w-[360px] lg:flex-shrink-0 flex-col card overflow-hidden',
            selectedConversationId === null ? 'flex' : 'hidden lg:flex'
          )}
        >
          <ConversationList
            conversations={conversations}
            loading={loading}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={loadMoreConversations}
            channels={channels}
            counts={counts}
            search={search}
            statusFilter={statusFilter}
            channelFilter={channelFilter}
            onSearchChange={setSearch}
            onStatusFilterChange={setStatusFilter}
            onChannelFilterChange={setChannelFilter}
            onRefresh={handleRefresh}
            selectedConversationId={selectedConversationId}
            onSelect={setSelectedConversationId}
          />
        </div>

        <div
          className={cn(
            'flex-1 card overflow-hidden flex-col',
            selectedConversationId === null ? 'hidden lg:flex' : 'flex'
          )}
        >
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
              onStatusChanged={handleStatusChanged}
              onBack={() => setSelectedConversationId(null)}
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
