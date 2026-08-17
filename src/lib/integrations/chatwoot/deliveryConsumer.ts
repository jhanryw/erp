/**
 * Consumer de `integration_event_deliveries` pro destino `chatwoot` (Fase
 * 4, seção 31 do pedido; contadores/skip revisados na Fase 5, seções 11/14).
 *
 * Fluxo: claim → resolve customer_id do evento → reconcileCustomerToChatwoot
 * → classifica synced / skipped (terminal, sem nada pra sincronizar,
 * NUNCA retryado) / failed (retryable, respeita Retry-After) / dead
 * (erro permanente ou backoff esgotado). Falha aqui NUNCA afeta o evento
 * `integration_outbox` em si nem qualquer delivery de outro destino (prova
 * em `supabase/tests/integration_event_deliveries_independence.test.sql`).
 *
 * Chamado pelo runner (`src/lib/integrations/runner.ts`), nunca direto por
 * um scheduler — este arquivo não decide COMO/QUANDO é invocado.
 */

import { claimEventDeliveries, markDeliveryFailed, markDeliveryProcessed, markDeliverySkipped } from '@/services/integrations/deliveries.service'
import { getOutboxEventById } from '@/services/integrations/outbox.service'
import { reconcileCustomerToChatwoot } from './reconciliation'

export interface ConsumeChatwootDeliveriesResult {
  claimed: number
  synced: number
  skipped: number
  failed: number
  dead: number
}

// Estados de reconciliação que representam "nada mais a fazer agora" —
// terminal, não é erro do Chatwoot, não adianta re-tentar a MESMA linha de
// delivery (a próxima vinculação, se acontecer, nasce de outro gatilho —
// um futuro evento contact_created, não desta fila). Seção 11 do pedido da
// Fase 5: distinto de "processed" (sincronizado de verdade) na observabilidade.
const SKIPPED_OUTCOMES = new Set([
  'not_linked',
  'no_person',
  'ambiguous_person',
  'anonymous_customer',
  'integration_not_active',
])

export async function consumeChatwootDeliveries(
  limit = 10,
  workerId = 'chatwoot-consumer',
): Promise<{ ok: true; data: ConsumeChatwootDeliveriesResult } | { ok: false; error: string }> {
  const claimResult = await claimEventDeliveries('chatwoot', limit, workerId)
  if (!claimResult.ok) return { ok: false, error: claimResult.error }

  let synced = 0
  let skipped = 0
  let failed = 0
  let dead = 0

  for (const delivery of claimResult.data) {
    const eventResult = await getOutboxEventById(delivery.outbox_event_id)
    if (!eventResult.ok || !eventResult.data) {
      await markDeliveryFailed(delivery.id, delivery.company_id, 'Evento de outbox associado não encontrado.', { permanent: true })
      dead++
      continue
    }

    const customerIdRaw = (eventResult.data.payload as Record<string, unknown>).customer_id
    if (customerIdRaw == null) {
      // sale.completed de cliente anônimo não tem customer_id útil aqui —
      // não é erro, é um estado terminal válido (nada pra sincronizar).
      await markDeliverySkipped(delivery.id, delivery.company_id, 'Evento sem customer_id no payload (venda de cliente anônimo).')
      skipped++
      continue
    }

    const reconcileResult = await reconcileCustomerToChatwoot(delivery.company_id, Number(customerIdRaw))
    if (!reconcileResult.ok) {
      // Falha de infraestrutura nossa (ex.: Postgres), não da API do
      // Chatwoot — sempre retryable, sem Retry-After específico.
      await markDeliveryFailed(delivery.id, delivery.company_id, reconcileResult.error)
      failed++
      continue
    }

    const outcome = reconcileResult.data
    if (outcome.status === 'synced') {
      await markDeliveryProcessed(delivery.id, delivery.company_id)
      synced++
    } else if (SKIPPED_OUTCOMES.has(outcome.status)) {
      await markDeliverySkipped(delivery.id, delivery.company_id, `Nada a sincronizar: ${outcome.status}`)
      skipped++
    } else if (outcome.status === 'permanent_error') {
      await markDeliveryFailed(delivery.id, delivery.company_id, outcome.message, { permanent: true })
      dead++
    } else if (outcome.status === 'retryable_error') {
      // Honra Retry-After de um 429 do Chatwoot quando presente (seção 13
      // do pedido da Fase 5) — senão cai no backoff padrão.
      await markDeliveryFailed(delivery.id, delivery.company_id, outcome.message, { retryAfterSeconds: outcome.retryAfterSeconds })
      failed++
    }
  }

  return { ok: true, data: { claimed: claimResult.data.length, synced, skipped, failed, dead } }
}
