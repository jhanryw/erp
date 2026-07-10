export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { getConversationCounts } from '@/services/crm/conversations.service'
import { ok, forbidden, err } from '@/lib/api/response'

// ─── GET /api/crm/conversations/counts ──────────────────────────────────────
// Contagem por status pra Inbox (Entrega 9) — endpoint separado de
// GET /api/crm/conversations de propósito: representa o total da empresa,
// independente do filtro/paginação da lista visível no momento.
export async function GET() {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const result = await getConversationCounts(user.company_id)
  if (!result.ok) return err(result.error, result.status)

  return ok({ counts: result.data })
}
