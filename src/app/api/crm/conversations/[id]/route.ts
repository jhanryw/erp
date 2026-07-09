export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { getConversation } from '@/services/crm/conversations.service'
import { getPerson } from '@/services/crm/persons.service'
import { getChannel } from '@/services/crm/channels.service'
import { getChannelIdentity } from '@/services/crm/channel-identities.service'
import { ok, err, forbidden } from '@/lib/api/response'

// ─── GET /api/crm/conversations/[id] ────────────────────────────────────────
// Detalhe de uma conversa (abrir na Inbox) — reaproveita getConversation()
// (Entrega 2, já garante posse por empresa) e resolve pessoa/canal/identidade
// pra exibição, sem nenhuma mudança nesses services.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const conversationId = Number(params.id)
  if (!Number.isFinite(conversationId) || conversationId <= 0) {
    return err('ID de conversa inválido.', 400)
  }

  const conversationResult = await getConversation(conversationId, user.company_id)
  if (!conversationResult.ok) return err(conversationResult.error, conversationResult.status)
  const conversation = conversationResult.data

  const [personResult, channelResult, identityResult] = await Promise.all([
    getPerson(conversation.person_id, user.company_id),
    getChannel(conversation.channel_id, user.company_id),
    getChannelIdentity(conversation.channel_identity_id, user.company_id),
  ])

  return ok({
    conversation,
    person: personResult.ok ? personResult.data : null,
    channel: channelResult.ok ? channelResult.data : null,
    channel_identity: identityResult.ok ? identityResult.data : null,
  })
}
