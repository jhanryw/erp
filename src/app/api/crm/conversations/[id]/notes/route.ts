export const dynamic = 'force-dynamic'

import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { getConversation } from '@/services/crm/conversations.service'
import { createConversationNote, listConversationNotes } from '@/services/crm/conversation-notes.service'
import { ok, err, forbidden, validationError } from '@/lib/api/response'

const schema = z.object({
  content: z.string().trim().min(1, 'Conteúdo da nota é obrigatório.').max(4000),
})

// ─── GET /api/crm/conversations/[id]/notes ──────────────────────────────────
// Lista notas internas da conversa (Entrega 9), mais recente primeiro —
// simples, sem edição/exclusão nesta entrega.
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

  const result = await listConversationNotes(conversationId, user.company_id)
  if (!result.ok) return err(result.error, result.status)

  const notes = result.data.map((note) => ({
    id: note.id,
    content: note.content,
    created_by: note.created_by,
    created_by_name: note.createdByName,
    created_at: note.created_at,
  }))

  return ok({ notes })
}

// ─── POST /api/crm/conversations/[id]/notes ─────────────────────────────────
// Cria nota interna — nunca visível pro cliente, sempre autoria humana da
// sessão (created_by = user.id), nunca automação.
export async function POST(request: Request, { params }: { params: { id: string } }) {
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

  const result = await createConversationNote({
    companyId: user.company_id,
    conversationId,
    content: parsed.data.content,
    createdBy: user.id,
  })
  if (!result.ok) return err(result.error, result.status)

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'create', resource: 'crm_conversation_note',
    resourceId: result.data.id,
    detail: `conversation:${conversationId}`,
    after: { conversation_id: conversationId, content: result.data.content },
  })

  return ok({
    note: {
      id: result.data.id,
      content: result.data.content,
      created_by: result.data.created_by,
      created_at: result.data.created_at,
    },
  }, 201)
}
