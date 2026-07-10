export const dynamic = 'force-dynamic'

import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { getConversation, updateConversationStatus } from '@/services/crm/conversations.service'
import { ok, err, forbidden, validationError } from '@/lib/api/response'

const schema = z.object({
  status: z.enum(['open', 'pending', 'closed']),
})

// ─── PATCH /api/crm/conversations/[id]/status ───────────────────────────────
// Ação manual de atendimento (Entrega 9) — abrir/marcar pendente/encerrar.
// Transições livres entre os 3 status, sem máquina de estados (decisão
// explícita do usuário). Reaproveita updateConversationStatus() sem mudar a
// função além do tratamento de conflito (ver comentário no service):
// reabrir uma conversa quando já existe outra open/pending pro mesmo
// canal/identidade responde 409 com mensagem clara, não 500 genérico.
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const conversationId = Number(params.id)
  if (!Number.isFinite(conversationId) || conversationId <= 0) {
    return err('ID de conversa inválido.', 400)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return err('JSON inválido.', 400)
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return validationError(parsed.error.flatten())

  const conversationResult = await getConversation(conversationId, user.company_id)
  if (!conversationResult.ok) return err(conversationResult.error, conversationResult.status)
  const before = conversationResult.data

  const result = await updateConversationStatus(conversationId, user.company_id, parsed.data.status)
  if (!result.ok) return err(result.error, result.status)

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'update', resource: 'crm_conversation',
    resourceId: conversationId,
    detail: `status: ${before.status} -> ${parsed.data.status}`,
    before: { status: before.status },
    after: { status: parsed.data.status },
  })

  return ok({ conversation: { id: conversationId, status: parsed.data.status } })
}
