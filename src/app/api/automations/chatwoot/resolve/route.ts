/**
 * FASE N2B — resolver customer → Chatwoot pra automações n8n.
 *
 * `POST /api/automations/chatwoot/resolve` — mesma auth/tenant dos
 * endpoints da Fase N1 (`Authorization: Bearer QARVON_AUTOMATION_SECRET`,
 * `company_id` sempre resolvido server-side via
 * `QARVON_AUTOMATION_COMPANY_ID`, nunca aceito do body).
 *
 * Body aceita `{customer_id}` OU `{phone}` — nunca `company_id`,
 * `account_id`, `inbox_id`, `conversation_id` nem token do Chatwoot (seção
 * 23, regras finais do pedido N2B). Toda a resolução de contact/conversation
 * acontece em `resolveCustomerChatwootContext` — esta rota só faz
 * parse/auth/mapeamento HTTP.
 *
 * Contrato de status HTTP (deliberado, documentado no relatório): desfechos
 * de NEGÓCIO previsíveis (seção 10 do pedido) — `customer_not_found`,
 * `ambiguous_customer`, `anonymous_customer`, `contact_ambiguous`,
 * `chatwoot_not_configured` — sempre `200 {ok:false, reason}`, mesma
 * filosofia do lookup da Fase N1 (diferenciar "não deu" de erro de infra).
 * `chatwoot_unavailable` (Chatwoot fora do ar/timeout/erro permanente de
 * config) é infra, não decisão de negócio — `503` se retryable, `502` se
 * permanente (token/config quebrados) — pra o n8n saber que deve
 * retry/alertar, não ramificar como se fosse um resultado válido.
 */

export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { requireAutomationSecret, resolveAutomationCompanyId } from '@/lib/auth/requireAutomationSecret'
import { resolveCustomerChatwootContext } from '@/lib/integrations/chatwoot/resolveCustomerChatwootContext'

export async function POST(request: Request) {
  const start = Date.now()

  if (!requireAutomationSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const tenant = resolveAutomationCompanyId()
  if (!tenant.ok) {
    console.error('[automations/chatwoot/resolve] tenant não configurado', { reason: tenant.reason })
    return NextResponse.json({ error: 'Configuração do servidor incompleta.' }, { status: 500 })
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const customerId = body && typeof body.customer_id === 'number' ? body.customer_id : undefined
  const phone = body && typeof body.phone === 'string' ? body.phone : undefined

  if (customerId === undefined && !phone) {
    return NextResponse.json({ error: 'Informe "customer_id" ou "phone".' }, { status: 422 })
  }

  const result = await resolveCustomerChatwootContext(tenant.companyId, { customerId, phone })

  const logBase = { company_id: tenant.companyId, latency_ms: Date.now() - start }

  if (!result.ok) {
    console.error('[automations/chatwoot/resolve] erro interno', { ...logBase, error: result.error })
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 })
  }

  const outcome = result.data

  if (outcome.status === 'resolved') {
    console.log('[automations/chatwoot/resolve]', { ...logBase, customer_id: outcome.customerId, contact_id: outcome.contactId, conversation_id: outcome.conversationId, result: 'resolved' })
    return NextResponse.json({
      ok: true,
      customer_id: outcome.customerId,
      contact_id: outcome.contactId,
      conversation_id: outcome.conversationId,
      inbox_id: outcome.inboxId,
    })
  }

  if (outcome.status === 'chatwoot_unavailable') {
    console.error('[automations/chatwoot/resolve]', { ...logBase, result: 'chatwoot_unavailable', permanent: outcome.permanent })
    const status = outcome.permanent ? 502 : 503
    const headers = outcome.retryAfterSeconds ? { 'Retry-After': String(outcome.retryAfterSeconds) } : undefined
    return NextResponse.json({ ok: false, reason: 'chatwoot_unavailable' }, { status, headers })
  }

  console.log('[automations/chatwoot/resolve]', { ...logBase, customer_id: customerId ?? null, result: outcome.status })
  return NextResponse.json({ ok: false, reason: outcome.status }, { status: 200 })
}
