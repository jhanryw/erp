/**
 * FASE N2B — envio de mensagem outgoing pra automações n8n, sem o n8n
 * conhecer conversation_id/inbox_id/token do Chatwoot.
 *
 * `POST /api/automations/chatwoot/send` — mesma auth/tenant das outras
 * rotas de automação. Body aceita `{customer_id|phone, content,
 * idempotency_key?, sale_id?, automation_name?}` — NUNCA `conversation_id`,
 * `inbox_id`, `account_id`, `base_url` nem token do Chatwoot vindos do n8n
 * (seção 12/23, regras finais do pedido N2B — "não permitir envio arbitrário
 * inseguro"/"não aceitar ... vindos do n8n").
 *
 * `automation_name`: aceito como campo opcional (seção 14 do pedido pede
 * pra registrar isso, mas o exemplo mínimo de body da seção 11 não inclui o
 * campo) — se ausente, derivado do prefixo de `idempotency_key` antes do
 * primeiro `:` (convenção que o próprio exemplo do pedido já usa:
 * `"post-sale:123:thank-you"`), ou `'unspecified'` se nenhum dos dois vier.
 * Decisão documentada no relatório, seção D.
 *
 * ORDEM CRÍTICA pra idempotência real (seção 13 do pedido — "não enviar a
 * mesma mensagem duas vezes por retry do n8n"): o `customer_id` é resolvido
 * primeiro (sem tocar o Chatwoot), a `idempotency_key` é reivindicada EM
 * SEGUIDA, e só DEPOIS do claim é que `sendChatwootMessageToCustomer` (que
 * de fato envia) é chamado. Um retry com a mesma chave nunca chega a enviar
 * de novo — ele para no claim (`status: 'duplicate'`) antes de qualquer
 * chamada ao Chatwoot.
 */

export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { requireAutomationSecret, resolveAutomationCompanyId } from '@/lib/auth/requireAutomationSecret'
import { resolveCustomerIdForAutomation, sendChatwootMessageToCustomer } from '@/lib/integrations/chatwoot/resolveCustomerChatwootContext'
import { claimAutomationMessage, markAutomationMessageSent, markAutomationMessageFailed } from '@/services/automations/automation-message-log.service'

const MAX_CONTENT_LENGTH = 4000 // limite de aplicação (seção 12 do pedido) — não documentado oficialmente pelo Chatwoot, valor conservador pra WhatsApp/canais de texto

function deriveAutomationName(explicit: unknown, idempotencyKey: string | undefined): string {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  if (idempotencyKey) {
    const prefix = idempotencyKey.split(':')[0]
    if (prefix) return prefix
  }
  return 'unspecified'
}

export async function POST(request: Request) {
  const start = Date.now()

  if (!requireAutomationSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const tenant = resolveAutomationCompanyId()
  if (!tenant.ok) {
    console.error('[automations/chatwoot/send] tenant não configurado', { reason: tenant.reason })
    return NextResponse.json({ error: 'Configuração do servidor incompleta.' }, { status: 500 })
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const customerId = body && typeof body.customer_id === 'number' ? body.customer_id : undefined
  const phone = body && typeof body.phone === 'string' ? body.phone : undefined
  const content = body && typeof body.content === 'string' ? body.content.trim() : ''
  const idempotencyKey = body && typeof body.idempotency_key === 'string' && body.idempotency_key.trim() ? body.idempotency_key.trim() : undefined
  const saleId = body && typeof body.sale_id === 'number' ? body.sale_id : undefined

  if (customerId === undefined && !phone) {
    return NextResponse.json({ error: 'Informe "customer_id" ou "phone".' }, { status: 422 })
  }
  if (!content) {
    return NextResponse.json({ error: 'Campo "content" é obrigatório e não pode ser vazio.' }, { status: 422 })
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return NextResponse.json({ error: `Campo "content" excede o limite de ${MAX_CONTENT_LENGTH} caracteres.` }, { status: 422 })
  }

  const automationName = deriveAutomationName(body?.automation_name, idempotencyKey)

  // ── 1. Resolve SÓ o customer_id (sem tocar o Chatwoot) ──────────────────────
  const customerResult = await resolveCustomerIdForAutomation(tenant.companyId, { customerId, phone })
  if (!customerResult.ok) {
    console.error('[automations/chatwoot/send] erro interno', { company_id: tenant.companyId, error: customerResult.error })
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 })
  }
  if ('outcome' in customerResult.data) {
    console.log('[automations/chatwoot/send]', { company_id: tenant.companyId, automation_name: automationName, result: customerResult.data.outcome.status })
    return NextResponse.json({ ok: false, reason: customerResult.data.outcome.status }, { status: 200 })
  }
  const resolvedCustomerId = customerResult.data.customerId

  // ── 2. Reivindica idempotency_key ANTES de qualquer chamada ao Chatwoot ────
  const claimResult = await claimAutomationMessage({
    companyId: tenant.companyId,
    automationName,
    customerId: resolvedCustomerId,
    saleId,
    idempotencyKey,
  })
  if (!claimResult.ok) {
    console.error('[automations/chatwoot/send] erro ao reivindicar idempotency_key', { company_id: tenant.companyId, customer_id: resolvedCustomerId, error: claimResult.error })
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 })
  }

  if (claimResult.data.status === 'duplicate') {
    console.log('[automations/chatwoot/send]', { company_id: tenant.companyId, automation_name: automationName, customer_id: resolvedCustomerId, result: 'duplicate_idempotency_key' })
    return NextResponse.json({
      ok: true,
      customer_id: resolvedCustomerId,
      conversation_id: claimResult.data.log.conversation_id ? Number(claimResult.data.log.conversation_id) : null,
      message_id: claimResult.data.log.external_message_id,
      idempotent: true,
    })
  }

  if (claimResult.data.status === 'in_progress') {
    return NextResponse.json({ error: 'Já existe um envio em andamento para esta idempotency_key.' }, { status: 409 })
  }

  const logId = claimResult.data.logId

  // ── 3. Só agora resolve contato/conversa e envia de fato ────────────────────
  const sendResult = await sendChatwootMessageToCustomer(tenant.companyId, { customerId: resolvedCustomerId }, content)

  if (!sendResult.ok) {
    await markAutomationMessageFailed({ logId, companyId: tenant.companyId, errorMessage: sendResult.error })
    console.error('[automations/chatwoot/send] erro interno', { company_id: tenant.companyId, customer_id: resolvedCustomerId, error: sendResult.error })
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 })
  }

  const outcome = sendResult.data

  if (outcome.status === 'chatwoot_unavailable') {
    await markAutomationMessageFailed({ logId, companyId: tenant.companyId, errorMessage: outcome.message })
    console.error('[automations/chatwoot/send]', { company_id: tenant.companyId, customer_id: resolvedCustomerId, result: 'chatwoot_unavailable', permanent: outcome.permanent })
    const status = outcome.permanent ? 502 : 503
    const headers = outcome.retryAfterSeconds ? { 'Retry-After': String(outcome.retryAfterSeconds) } : undefined
    return NextResponse.json({ ok: false, reason: 'chatwoot_unavailable' }, { status, headers })
  }

  if (outcome.status !== 'sent') {
    await markAutomationMessageFailed({ logId, companyId: tenant.companyId, errorMessage: outcome.status })
    console.log('[automations/chatwoot/send]', { company_id: tenant.companyId, customer_id: resolvedCustomerId, result: outcome.status })
    return NextResponse.json({ ok: false, reason: outcome.status }, { status: 200 })
  }

  await markAutomationMessageSent({ logId, companyId: tenant.companyId, conversationId: outcome.conversationId, externalMessageId: String(outcome.messageId) })

  console.log('[automations/chatwoot/send]', {
    company_id: tenant.companyId,
    automation_name: automationName,
    customer_id: outcome.customerId,
    conversation_id: outcome.conversationId,
    result: 'sent',
    latency_ms: Date.now() - start,
  })

  return NextResponse.json({
    ok: true,
    customer_id: outcome.customerId,
    conversation_id: outcome.conversationId,
    message_id: outcome.messageId,
    idempotent: false,
  })
}
