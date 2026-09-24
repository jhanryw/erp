export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { enqueueMercadoLivreNotification, parseMercadoLivreNotification } from '@/services/channels/inboundEvents.service'
import { runInboundCycle } from '@/services/channels/inboundCycle.service'
import { logMercadoLivre } from '@/lib/integrations/mercadolivre/log'

/**
 * POST /api/webhooks/mercadolivre — callback de notificações do app ML.
 *
 * Público (prefixo /api/webhooks/ em PUBLIC_PATHS) e RÁPIDO: o ML exige 200
 * em até 500 ms, senão reenvia e pode desativar os tópicos. Aqui só:
 *   valida o formato → enfileira (empresa/integração resolvidas no banco
 *   pelo user_id; application_id conferido com o app) → 200.
 * O processamento roda depois (disparo sem await + job agendado). A
 * notificação nunca é a fonte de verdade: o worker relê o pedido na API.
 * Não há assinatura na notificação do ML — por isso nada do corpo é
 * confiado além de "algo mudou neste recurso desta conta".
 */
export async function POST(request: Request) {
  let body: unknown
  try {
    const text = await request.text()
    if (text.length > 10_000) return NextResponse.json({ error: 'payload grande demais' }, { status: 413 })
    body = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const n = parseMercadoLivreNotification(body)
  if (!n) return NextResponse.json({ error: 'notificação inválida' }, { status: 400 })

  let outcome
  try {
    outcome = await enqueueMercadoLivreNotification(n, { expectedApplicationId: process.env.MERCADOLIVRE_CLIENT_ID ?? null })
  } catch (err) {
    // Falha ao persistir → 500: o ML reenvia (até 1h). Nunca perder evento.
    console.error('[webhooks/mercadolivre] falha ao enfileirar', err instanceof Error ? err.message : 'erro')
    return NextResponse.json({ error: 'indisponível' }, { status: 500 })
  }

  logMercadoLivre('mercadolivre.webhook.received', { topic: n.topic, seller_id: n.user_id, reason: outcome })

  if (outcome === 'queued' || outcome === 'coalesced') {
    // Dispara o worker sem segurar a resposta; o job agendado garante o resto.
    void runInboundCycle(`webhook-${randomUUID()}`, { limit: 5 }).catch((err) =>
      console.error('[webhooks/mercadolivre] ciclo imediato falhou (job agendado reprocessa)', err instanceof Error ? err.message : 'erro'))
  }

  // Conta desconhecida / tópico não tratado / outro app: 200 para o ML não
  // desativar os tópicos — nada é processado.
  return NextResponse.json({ ok: true, outcome })
}
