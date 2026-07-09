export const dynamic = 'force-dynamic'

import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { sendOutboundMessage } from '@/services/crm/outbound-message.service'
import { ok, err, forbidden, validationError } from '@/lib/api/response'
import type { Json } from '@/types/database.types'

const schema = z.object({
  content: z.string().max(10000).optional(),
  content_type: z.enum(['text', 'image', 'audio', 'video', 'document', 'location', 'contact', 'other']),
  media_public_id: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
  reply_to_message_id: z.coerce.number().int().positive().optional(),
  client_dedupe_key: z.string().uuid('client_dedupe_key deve ser um UUID gerado pelo cliente antes do envio'),
})

// ─── POST /api/crm/conversations/[id]/messages ─────────────────────────────────
// Envia uma mensagem outbound dentro de uma conversa já existente (sem
// outbound frio nesta entrega). Sessão autenticada (não secret) — primeira
// escrita humana real nas tabelas do CRM. company_id nunca vem do corpo,
// sempre da sessão; a conversa precisa pertencer à mesma empresa
// (getConversation já garante isso), o que impede um agente de alcançar
// conversa de outra empresa.
//
// ERP cria a mensagem 'pending', chama o provider (webhook N8N síncrono,
// nunca o Evolution direto) e já responde com o estado final (sent/failed)
// — sem endpoint de callback separado para esta transição inicial. Eventos
// posteriores (delivered/read) continuam chegando pela Entrega 5, sem
// nenhuma mudança lá.
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

  const result = await sendOutboundMessage({
    conversationId,
    companyId: user.company_id,
    userId: user.id,
    content: parsed.data.content ?? null,
    contentType: parsed.data.content_type,
    mediaPublicId: parsed.data.media_public_id ?? null,
    metadata: (parsed.data.metadata as Json | undefined) ?? null,
    replyToMessageId: parsed.data.reply_to_message_id ?? null,
    clientDedupeKey: parsed.data.client_dedupe_key,
  })

  if (!result.ok) return err(result.error, result.status)

  if (!result.data.deduplicated) {
    auditLog({
      userId: user.id, userRole: user.role,
      action: 'create', resource: 'crm_message',
      resourceId: result.data.message.id,
      detail: `conversation:${conversationId} status=${result.data.message.status}`,
      after: {
        conversation_id: result.data.message.conversation_id,
        content_type: result.data.message.content_type,
        status: result.data.message.status,
        external_message_id: result.data.message.external_message_id,
        provider_error: result.data.providerError,
        status_update_error: result.data.statusUpdateError,
      },
    })
  }

  // provider_error/status_update_error sempre presentes no corpo (null quando
  // não houve problema) — nunca só no log do servidor. Ver auditoria da
  // Entrega 6: antes desta correção, falha ao gravar sent/failed após o
  // envio real ficava invisível pro chamador (mensagem parecia "sucesso",
  // status ficava pending sem explicação).
  return ok({
    message: result.data.message,
    deduplicated: result.data.deduplicated,
    provider_error: result.data.providerError,
    status_update_error: result.data.statusUpdateError,
  }, result.data.deduplicated ? 200 : 201)
}
