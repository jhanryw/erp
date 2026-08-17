/**
 * Webhook inbound do Chatwoot (Fase 3 — Chatwoot Inbound).
 *
 * Rota fina por desenho (seção 33 do pedido): corpo bruto → resolve
 * integração candidata → verifica assinatura → SÓ DEPOIS despacha. Toda a
 * lógica de negócio vive em `src/lib/integrations/chatwoot/**` e nos
 * services já existentes (Fases 1-2) — nada aqui além de orquestração HTTP.
 *
 * NÃO usa sessão Supabase (por isso está em PUBLIC_PATHS, path exato — ver
 * src/middleware.ts) — autentica só pela assinatura HMAC do Chatwoot.
 */

export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { verifyChatwootWebhookSignature } from '@/lib/integrations/chatwoot/signature'
import { extractUnverifiedAccountId } from '@/lib/integrations/chatwoot/types'
import { dispatchChatwootEvent } from '@/lib/integrations/chatwoot/eventDispatcher'
import { findIntegrationByExternalAccount } from '@/services/integrations/company-integrations.service'
import { getIntegrationSecret } from '@/services/integrations/secrets.service'

export async function POST(request: Request) {
  // ── Corpo bruto ANTES de qualquer parse que possa alterar bytes ──────────
  let rawBody: string
  try {
    rawBody = await request.text()
  } catch {
    return NextResponse.json({ error: 'Erro ao ler body.' }, { status: 400 })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  // ── 1. Candidato de tenant — NÃO confiável ainda, só seleciona o secret ──
  // (seção 7/10 do pedido: account_id do payload nunca é autoridade antes
  // da assinatura validar; usar só pra escolher QUAL secret testar é seguro)
  const accountIdCandidate = extractUnverifiedAccountId(parsed)
  if (!accountIdCandidate) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const integrationResult = await findIntegrationByExternalAccount('chatwoot', accountIdCandidate)
  if (!integrationResult.ok || !integrationResult.data || integrationResult.data.status !== 'active') {
    // Nunca diferenciar "não existe" de "existe mas inativo" na resposta —
    // não vazar informação sobre integrações de outras empresas (seção 9).
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const integration = integrationResult.data

  const secretResult = await getIntegrationSecret(integration.id, integration.company_id, 'webhook_secret')
  if (!secretResult.ok || !secretResult.data) {
    console.error('[chatwoot/webhook] webhook_secret ausente para integração', { integration_id: integration.id })
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // ── 2. Verificação de assinatura — SÓ A PARTIR DAQUI confiamos em algo ──
  const verification = verifyChatwootWebhookSignature({
    rawBody,
    timestampHeader: request.headers.get('X-Chatwoot-Timestamp'),
    signatureHeader: request.headers.get('X-Chatwoot-Signature'),
    secret: secretResult.data,
  })

  if (!verification.ok) {
    console.warn('[chatwoot/webhook] assinatura rejeitada', {
      integration_id: integration.id,
      company_id: integration.company_id,
      reason: verification.reason,
    })
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // ── 3. Defesa em profundidade: account do payload (agora confiável) ──────
  // precisa bater com a integração que forneceu o secret usado pra validar
  // — nunca deveria divergir, mas confirma explicitamente (seção 37).
  if (accountIdCandidate !== integration.external_account_id) {
    console.error('[chatwoot/webhook] account mismatch pós-assinatura', { integration_id: integration.id })
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // ── 4. Despacho — só trabalho local ao banco, nenhuma chamada externa ────
  const result = await dispatchChatwootEvent(parsed, integration)

  // Log seguro (seção 31): nunca telefone/email/mensagem/token completos.
  console.log('[chatwoot/webhook]', {
    provider: 'chatwoot',
    event: result.event,
    integration_id: integration.id,
    company_id: integration.company_id,
    chatwoot_account_id: integration.external_account_id,
    handled: result.handled,
    outcome: result.outcome ?? result.reason,
  })

  // 5xx só pra falha interna real (worth retry) — payload irrelevante ou
  // evento não consumido nesta fase sempre volta 2xx pra nunca causar
  // retry-loop do Chatwoot (seção 30).
  if (!result.handled && result.reason === 'resolution_failed') {
    return NextResponse.json({ ok: false }, { status: 500 })
  }

  return NextResponse.json({ ok: true }, { status: 200 })
}
