export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { listChannels } from '@/services/crm/channels.service'
import { ok, err, forbidden } from '@/lib/api/response'

// ─── GET /api/crm/channels ──────────────────────────────────────────────────
// Lista os canais da empresa — usado pelo filtro de canal da Inbox
// (Entrega 7). Primeira rota humana consumindo listChannels() (Entrega 1),
// sem nenhuma mudança nela.
export async function GET(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const { searchParams } = new URL(request.url)
  const includeInactive = searchParams.get('include_inactive') === 'true'

  const result = await listChannels(user.company_id, { includeInactive })
  if (!result.ok) return err(result.error, result.status)

  return ok({ channels: result.data })
}
