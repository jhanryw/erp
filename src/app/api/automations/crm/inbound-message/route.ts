import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ingestInboundMessage } from '@/services/crm/inbound-ingestion.service'
import type { Json } from '@/types/database.types'

export const dynamic = 'force-dynamic'

// Secret dedicado ao CRM — isolado de N8N_AUTOMATION_SECRET (pós-venda) por
// decisão explícita, para não acoplar o raio de exposição das duas automações.
function isAuthorized(request: Request): boolean {
  const secret = process.env.N8N_CRM_SECRET
  if (!secret) return false
  return request.headers.get('Authorization') === `Bearer ${secret}`
}

// media.base64_content: 25MB (teto atual de media-private) inflado em base64
// (~4/3) fica perto de 34MB — cap de 35_000_000 chars é só sanidade de
// payload gigante malformado, não é a validação real de MIME/tamanho (essa
// acontece dentro de ingestInboundMessage via BUCKET_RULES do Media Hub, com
// degradação graciosa — mensagem sem anexo, não erro de request).
const mediaSchema = z.object({
  mime_type: z.string().min(1),
  file_size: z.number().int().positive(),
  base64_content: z.string().min(1).max(35_000_000),
  file_name: z.string().max(255).optional(),
})

const schema = z.object({
  provider_instance_identifier: z.string().min(1),
  sender_identity_value: z.string().min(1),
  sender_display_name: z.string().max(200).optional(),
  external_message_id: z.string().min(1),
  content: z.string().max(10000).optional(),
  content_type: z.enum(['text', 'image', 'audio', 'video', 'document', 'location', 'contact', 'other']),
  n8n_execution_id: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  media: mediaSchema.optional(),
})

// ─── POST /api/automations/crm/inbound-message ─────────────────────────────────
// Ingestão de mensagem inbound (N8N → ERP, WhatsApp/Evolution ou outro canal
// já cadastrado em crm_channels). Mesmo padrão de /api/automations/post-sale/*:
// N8N só sequencia/executa, toda regra de negócio (resolução de canal,
// pessoa, identidade, conversa, idempotência, anexo de mídia) vive aqui.
//
// Canal não encontrado ou inativo é ERRO PERMANENTE de configuração — responde
// 422, não 404, para não induzir retry-loop automático em N8N/Evolution
// (decisão explícita do usuário).
//
// Mídia (Entrega 4): N8N baixa da Evolution e envia os bytes como base64
// neste mesmo endpoint — Evolution nunca fala com o ERP/Media Hub direto.
// MIME não permitido ou arquivo grande demais NÃO derruba a mensagem
// (degradação graciosa) — resposta sinaliza via `media: null` + `media_error`.
// Anexo é vinculado via Media Hub (media/media_usages), nunca por rota
// humana — sempre chamada direta de service layer. Sem UI, sem outbound.
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
    metadata,
    media,
  } = parsed.data

  const result = await ingestInboundMessage({
    providerInstanceIdentifier: provider_instance_identifier,
    senderIdentityValue: sender_identity_value,
    senderDisplayName: sender_display_name ?? null,
    externalMessageId: external_message_id,
    content: content ?? null,
    contentType: content_type,
    n8nExecutionId: n8n_execution_id ?? null,
    metadata: (metadata as Json | undefined) ?? null,
    media: media
      ? { mimeType: media.mime_type, fileSize: media.file_size, base64Content: media.base64_content, fileName: media.file_name ?? null }
      : null,
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
    media_public_id: result.data.media?.publicId ?? null,
    media_error: result.data.mediaError,
  })

  return NextResponse.json({
    ok: true,
    id: result.data.messageId,
    conversation_id: result.data.conversationId,
    deduplicated: result.data.deduplicated,
    media: result.data.media,
    media_error: result.data.mediaError,
  })
}
