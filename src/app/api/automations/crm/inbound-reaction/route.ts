import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ingestInboundReaction } from '@/services/crm/reactions.service'
import { checkContractVersion, unsupportedContractVersionBody } from '@/services/crm/contract-version'

export const dynamic = 'force-dynamic'

// Mesmo secret do /api/automations/crm/inbound-message e /message-status —
// mesmo domínio de integração (WhatsApp/Evolution via N8N), mesma decisão
// já registrada de não fragmentar mais secrets dentro do mesmo domínio.
function isAuthorized(request: Request): boolean {
  const secret = process.env.N8N_CRM_SECRET
  if (!secret) return false
  return request.headers.get('Authorization') === `Bearer ${secret}`
}

const schema = z.object({
  contract_version: z.number().int().optional(),
  provider_instance_identifier: z.string().min(1),
  external_message_id: z.string().min(1), // mensagem original sendo reagida
  reactor_identity_value: z.string().min(1),
  emoji: z.string().max(32).nullable().optional(), // vazio/null/ausente = remover
  n8n_execution_id: z.string().optional(),
})

// ─── POST /api/automations/crm/inbound-reaction ─────────────────────────────────
// Ingestão de reaction inbound (N8N → ERP) — Entrega 5. Uma reaction não é
// uma crm_messages (sem content, sem ciclo de status), por isso rota e
// tabela próprias em vez de reaproveitar /inbound-message.
//
// Canal não encontrado/inativo é erro PERMANENTE (422), igual às outras
// rotas de automação do CRM. Mensagem original não encontrada NÃO é erro —
// resposta 200 com applied:false + reason, nunca induz retry (mesmo padrão
// de /message-status): a reação pode legitimamente chegar antes da
// mensagem original ser ingerida.
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

  if (!checkContractVersion(body).ok) {
    return NextResponse.json(unsupportedContractVersionBody, { status: 422 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const {
    provider_instance_identifier,
    external_message_id,
    reactor_identity_value,
    emoji,
    n8n_execution_id,
  } = parsed.data

  const result = await ingestInboundReaction({
    providerInstanceIdentifier: provider_instance_identifier,
    externalMessageId: external_message_id,
    reactorIdentityValue: reactor_identity_value,
    emoji: emoji ?? null,
  })

  if (!result.ok) {
    console.error('[POST /api/automations/crm/inbound-reaction]', {
      provider_instance_identifier,
      external_message_id,
      n8n_execution_id,
      error: result.error,
      status: result.status,
    })
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  console.info('[POST /api/automations/crm/inbound-reaction]', {
    provider_instance_identifier,
    external_message_id,
    n8n_execution_id,
    company_id: result.data.companyId,
    message_id: result.data.messageId,
    applied: result.data.applied,
    reason: result.data.reason,
    removed: result.data.removed,
    reaction_id: result.data.reactionId,
  })

  return NextResponse.json({
    ok: true,
    applied: result.data.applied,
    reason: result.data.reason,
    removed: result.data.removed,
    message_id: result.data.messageId,
    reaction_id: result.data.reactionId,
  })
}
