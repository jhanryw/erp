import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ingestInboundMessage } from '@/services/crm/inbound-ingestion.service'
import { checkContractVersion, unsupportedContractVersionBody } from '@/services/crm/contract-version'
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

const contentTypeEnum = z.enum(['text', 'image', 'audio', 'video', 'document', 'location', 'contact', 'sticker', 'other'])

// Snapshot limitado da mensagem citada (Entrega 3) — usado só como fallback
// visual quando reply_to_external_message_id não resolve pra uma mensagem
// já ingerida (ver comentário acima de ingestInboundMessage). Nunca duplica
// mídia nem conteúdo completo, por decisão explícita do usuário.
const quotedMessageSchema = z.object({
  external_message_id: z.string().min(1),
  content_type: contentTypeEnum,
  content_preview: z.string().max(500).optional(),
  sender_identity_value: z.string().max(200).optional(),
})

// Schemas formais de metadata por content_type (Entrega 4) — só location e
// contact ganham validação estrita (`.strict()`, sem chave arbitrária);
// os demais content_types continuam com `metadata` livre (comportamento
// preservado). Armazenamento não muda: ainda é a coluna `metadata` de
// crm_messages, só a validação de entrada fica formal.
const locationMetadataSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  address: z.string().max(300).optional(),
  name: z.string().max(200).optional(),
}).strict()

const contactMetadataSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(1).max(32),
  vcard: z.string().max(5000).optional(),
}).strict()

// Contexto de anúncio (Meta/Instagram "click to WhatsApp") — campo próprio,
// não sobrecarrega `metadata` livre nem cria um content_type novo. Sempre
// referência (URL/texto curto), nunca base64/binário — thumbnail_url é só
// um link, o ERP nunca baixa a imagem. `.strict()` rejeita objeto
// arbitrário, mesmo padrão de locationMetadataSchema/contactMetadataSchema.
const adContextSchema = z.object({
  type: z.literal('ad'),
  platform: z.string().min(1).max(50),
  title: z.string().max(200).optional(),
  body: z.string().max(500).optional(),
  source_url: z.string().url().max(2000).optional(),
  source_id: z.string().max(200).optional(),
  thumbnail_url: z.string().url().max(2000).optional(),
  media_type: z.string().max(50).optional(),
}).strict()

const schema = z.object({
  contract_version: z.number().int().optional(),
  provider_instance_identifier: z.string().min(1),
  sender_identity_value: z.string().min(1),
  sender_display_name: z.string().max(200).optional(),
  external_message_id: z.string().min(1),
  content: z.string().max(10000).optional(),
  content_type: contentTypeEnum,
  n8n_execution_id: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  media: mediaSchema.optional(),
  reply_to_external_message_id: z.string().min(1).optional(),
  quoted_message: quotedMessageSchema.optional(),
  ad_context: adContextSchema.optional(),
}).superRefine((data, ctx) => {
  if (data.content_type === 'location') {
    const result = locationMetadataSchema.safeParse(data.metadata ?? {})
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metadata'],
        message: `metadata inválido para content_type=location: ${result.error.message}`,
      })
    }
  }
  if (data.content_type === 'contact') {
    const result = contactMetadataSchema.safeParse(data.metadata ?? {})
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['metadata'],
        message: `metadata inválido para content_type=contact: ${result.error.message}`,
      })
    }
  }
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
  // Instrumentação temporária de latência (auditoria do pipeline de anúncio
  // Meta/Instagram) — correlation_id só pra cruzar linhas de log da mesma
  // requisição, nunca conteúdo sensível completo.
  const receivedAt = Date.now()
  const correlationId = crypto.randomUUID()

  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  if (!checkContractVersion(body).ok) {
    return NextResponse.json(unsupportedContractVersionBody, { status: 422 })
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
    reply_to_external_message_id,
    quoted_message,
    ad_context,
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
    replyToExternalMessageId: reply_to_external_message_id ?? null,
    quotedMessage: quoted_message
      ? {
          externalMessageId: quoted_message.external_message_id,
          contentType: quoted_message.content_type,
          contentPreview: quoted_message.content_preview ?? null,
          senderIdentityValue: quoted_message.sender_identity_value ?? null,
        }
      : null,
    adContext: ad_context
      ? {
          platform: ad_context.platform,
          title: ad_context.title ?? null,
          body: ad_context.body ?? null,
          sourceUrl: ad_context.source_url ?? null,
          sourceId: ad_context.source_id ?? null,
          thumbnailUrl: ad_context.thumbnail_url ?? null,
          mediaType: ad_context.media_type ?? null,
        }
      : null,
  })

  if (!result.ok) {
    console.error('[POST /api/automations/crm/inbound-message]', {
      correlation_id: correlationId,
      provider_instance_identifier,
      external_message_id,
      n8n_execution_id,
      has_ad_context: Boolean(ad_context),
      error: result.error,
      status: result.status,
      latency_ms: Date.now() - receivedAt,
    })
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  console.info('[POST /api/automations/crm/inbound-message]', {
    correlation_id: correlationId,
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
    has_ad_context: Boolean(ad_context),
    // Latência webhook→insert medida no servidor — não cobre tempo
    // Evolution→N8N nem N8N→ERP em trânsito (sem timestamp de origem no
    // payload atual), nem renderização no frontend (isso é client-side,
    // fora do alcance deste log).
    latency_ms: Date.now() - receivedAt,
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
