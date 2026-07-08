import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ingestInboundMessage } from '@/services/crm/inbound-ingestion.service'

export const dynamic = 'force-dynamic'

// Secret dedicado ao CRM — isolado de N8N_AUTOMATION_SECRET (pós-venda) por
// decisão explícita, para não acoplar o raio de exposição das duas automações.
function isAuthorized(request: Request): boolean {
  const secret = process.env.N8N_CRM_SECRET
  if (!secret) return false
  return request.headers.get('Authorization') === `Bearer ${secret}`
}

const schema = z.object({
  provider_instance_identifier: z.string().min(1),
  sender_identity_value: z.string().min(1),
  sender_display_name: z.string().max(200).optional(),
  external_message_id: z.string().min(1),
  content: z.string().max(10000).optional(),
  content_type: z.enum(['text', 'image', 'audio', 'video', 'document', 'location', 'other']),
  n8n_execution_id: z.string().optional(),
})

// ─── POST /api/automations/crm/inbound-message ─────────────────────────────────
// Ingestão de mensagem inbound (N8N → ERP, WhatsApp/Evolution ou outro canal
// já cadastrado em crm_channels). Mesmo padrão de /api/automations/post-sale/*:
// N8N só sequencia/executa, toda regra de negócio (resolução de canal,
// pessoa, identidade, conversa, idempotência) vive aqui.
//
// Canal não encontrado ou inativo é ERRO PERMANENTE de configuração — responde
// 422, não 404, para não induzir retry-loop automático em N8N/Evolution
// (decisão explícita do usuário). Sem Media Hub, sem UI, sem outbound nesta
// entrega.
export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const {
    provider_instance_identifier,
    sender_identity_value,
    sender_display_name,
    external_message_id,
    content,
    content_type,
    n8n_execution_id,
  } = parsed.data

  const result = await ingestInboundMessage({
    providerInstanceIdentifier: provider_instance_identifier,
    senderIdentityValue: sender_identity_value,
    senderDisplayName: sender_display_name ?? null,
    externalMessageId: external_message_id,
    content: content ?? null,
    contentType: content_type,
    n8nExecutionId: n8n_execution_id ?? null,
  })

  if (!result.ok) {
    console.error('[POST /api/automations/crm/inbound-message]', {
      provider_instance_identifier,
      external_message_id,
      n8n_execution_id,
      error: result.error,
      status: result.status,
    })
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  console.info('[POST /api/automations/crm/inbound-message]', {
    provider_instance_identifier,
    external_message_id,
    n8n_execution_id,
    company_id: result.data.companyId,
    channel_id: result.data.channelId,
    person_id: result.data.personId,
    conversation_id: result.data.conversationId,
    message_id: result.data.messageId,
    deduplicated: result.data.deduplicated,
  })

  return NextResponse.json({
    ok: true,
    id: result.data.messageId,
    conversation_id: result.data.conversationId,
    deduplicated: result.data.deduplicated,
  })
}
