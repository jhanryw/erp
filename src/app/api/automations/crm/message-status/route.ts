import { NextResponse } from 'next/server'
import { z } from 'zod'
import { syncMessageStatus } from '@/services/crm/message-status-sync.service'
import { checkContractVersion, unsupportedContractVersionBody } from '@/services/crm/contract-version'

export const dynamic = 'force-dynamic'

// Mesmo secret do /api/automations/crm/inbound-message — mesmo domínio de
// integração (WhatsApp/Evolution via N8N), decisão explícita de não
// fragmentar mais secrets dentro do mesmo domínio (diferente da separação
// post-sale/CRM, que é entre domínios de negócio distintos).
function isAuthorized(request: Request): boolean {
  const secret = process.env.N8N_CRM_SECRET
  if (!secret) return false
  return request.headers.get('Authorization') === `Bearer ${secret}`
}

const schema = z.object({
  contract_version: z.number().int().optional(),
  provider_instance_identifier: z.string().min(1),
  external_message_id: z.string().min(1),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  occurred_at: z.string().datetime().optional(),
  error_message: z.string().max(2000).optional(),
  n8n_execution_id: z.string().optional(),
})

// ─── POST /api/automations/crm/message-status ──────────────────────────────────
// Sincroniza status de mensagem outbound reportado pelo provider (Evolution,
// via N8N) — sent/delivered/read/failed. Mesmo padrão de
// /api/automations/crm/inbound-message: N8N só sequencia/executa, toda regra
// de negócio (resolução de canal, localização da mensagem, ordem/idempotência)
// vive aqui.
//
// Canal não encontrado/inativo é erro PERMANENTE (422), igual ao inbound.
// Mensagem não encontrada, não-outbound, ou status obsoleto (fora de ordem
// ou repetido) NÃO são erro — resposta 200 com applied:false + reason,
// nunca induz retry. Sem outbound real nesta entrega — reflete só o que já
// existe em crm_messages.
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
    status,
    occurred_at,
    error_message,
    n8n_execution_id,
  } = parsed.data

  const result = await syncMessageStatus({
    providerInstanceIdentifier: provider_instance_identifier,
    externalMessageId: external_message_id,
    status,
    occurredAt: occurred_at ?? null,
    errorMessage: error_message ?? null,
  })

  if (!result.ok) {
    console.error('[POST /api/automations/crm/message-status]', {
      provider_instance_identifier,
      external_message_id,
      status,
      n8n_execution_id,
      error: result.error,
      http_status: result.status,
    })
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  console.info('[POST /api/automations/crm/message-status]', {
    provider_instance_identifier,
    external_message_id,
    status,
    n8n_execution_id,
    company_id: result.data.companyId,
    message_id: result.data.messageId,
    applied: result.data.applied,
    reason: result.data.reason,
    current_status: result.data.currentStatus,
  })

  return NextResponse.json({
    ok: true,
    applied: result.data.applied,
    reason: result.data.reason,
    message_id: result.data.messageId,
    current_status: result.data.currentStatus,
  })
}
