export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { listConversations } from '@/services/crm/conversations.service'
import { ok, err, forbidden } from '@/lib/api/response'
import type { CrmConversationStatus } from '@/types/database.types'

const VALID_STATUSES: CrmConversationStatus[] = ['open', 'pending', 'closed']

// ─── GET /api/crm/conversations ─────────────────────────────────────────────
// Lista conversas da empresa (não de uma pessoa só) — consulta principal da
// Inbox (Entrega 7). Filtros opcionais: status, channel_id, person_id.
// Paginação simples por offset (mesma decisão de clientes/page.tsx).
export async function GET(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const { searchParams } = new URL(request.url)

  const statusParam = searchParams.get('status')
  const status = statusParam && VALID_STATUSES.includes(statusParam as CrmConversationStatus)
    ? (statusParam as CrmConversationStatus)
    : undefined

  const channelIdParam = searchParams.get('channel_id')
  const channelId = channelIdParam ? Number(channelIdParam) : undefined

  const personIdParam = searchParams.get('person_id')
  const personId = personIdParam ? Number(personIdParam) : undefined

  const limitParam = searchParams.get('limit')
  const limit = limitParam ? Number(limitParam) : undefined

  const offsetParam = searchParams.get('offset')
  const offset = offsetParam ? Number(offsetParam) : undefined

  // Busca por nome/telefone/última mensagem (Entrega 9) — parâmetro
  // opcional e aditivo, não muda o comportamento de quem já chama esta
  // rota sem `search`.
  const searchParam = searchParams.get('search')
  const search = searchParam && searchParam.trim() ? searchParam.trim() : undefined

  const result = await listConversations(user.company_id, { status, channelId, personId, search, limit, offset })
  if (!result.ok) return err(result.error, result.status)

  // Contrato JSON do projeto é snake_case (mesmo padrão de todo o resto da
  // API) — listConversations() devolve objetos compostos em camelCase
  // (idiomático em TS), a rota converte na borda.
  const conversations = result.data.conversations.map((conversation) => ({
    id: conversation.id,
    channel_id: conversation.channelId,
    channel_identity_id: conversation.channelIdentityId,
    person_id: conversation.personId,
    status: conversation.status,
    last_message_at: conversation.lastMessageAt,
    created_at: conversation.createdAt,
    person: conversation.person
      ? { id: conversation.person.id, display_name: conversation.person.displayName }
      : null,
    channel: conversation.channel
      ? { id: conversation.channel.id, name: conversation.channel.name, channel_type: conversation.channel.channelType }
      : null,
    channel_identity: conversation.channelIdentity
      ? { id: conversation.channelIdentity.id, value: conversation.channelIdentity.value }
      : null,
    last_message: conversation.lastMessage
      ? {
          content: conversation.lastMessage.content,
          content_type: conversation.lastMessage.contentType,
          direction: conversation.lastMessage.direction,
          status: conversation.lastMessage.status,
          created_at: conversation.lastMessage.createdAt,
        }
      : null,
  }))

  return ok({ conversations, has_more: result.data.hasMore })
}
