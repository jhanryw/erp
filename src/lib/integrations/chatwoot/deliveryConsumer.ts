/**
 * Consumer de `integration_event_deliveries` pro destino `chatwoot` (Fase
 * 4, seção 31 do pedido). NENHUM scheduler chama isso ainda — função
 * pronta pra ser invocada por teste manual ou por um cron futuro (Fase 5+).
 *
 * Fluxo: claim → resolve customer_id do evento → reconcileCustomerToChatwoot
 * → marca processed/failed/dead. Falha aqui NUNCA afeta o evento
 * `integration_outbox` em si nem qualquer delivery de outro destino (prova
 * em `supabase/tests/integration_event_deliveries_independence.test.sql`).
 */

import { claimEventDeliveries, markDeliveryFailed, markDeliveryProcessed } from '@/services/integrations/deliveries.service'
import { getOutboxEventById } from '@/services/integrations/outbox.service'
import { reconcileCustomerToChatwoot } from './reconciliation'

export interface ConsumeChatwootDeliveriesResult {
  claimed: number
  processed: number
  failed: number
  dead: number
}

// Estados de reconciliação que representam "nada mais a fazer agora" —
// terminal, não é erro do Chatwoot, não adianta re-tentar a MESMA linha de
// delivery (a próxima vinculação, se acontecer, nasce de outro gatilho —
// um futuro evento contact_created, não desta fila).
const TERMINAL_NON_SYNC_OUTCOMES = new Set([
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

  let processed = 0
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
      await markDeliveryProcessed(delivery.id, delivery.company_id)
      processed++
      continue
    }

    const reconcileResult = await reconcileCustomerToChatwoot(delivery.company_id, Number(customerIdRaw))
    if (!reconcileResult.ok) {
      await markDeliveryFailed(delivery.id, delivery.company_id, reconcileResult.error)
      failed++
      continue
    }

    const outcome = reconcileResult.data
    if (outcome.status === 'synced' || TERMINAL_NON_SYNC_OUTCOMES.has(outcome.status)) {
      await markDeliveryProcessed(delivery.id, delivery.company_id)
      processed++
    } else if (outcome.status === 'permanent_error') {
      await markDeliveryFailed(delivery.id, delivery.company_id, outcome.message, { permanent: true })
      dead++
    }
  }

  return { ok: true, data: { claimed: claimResult.data.length, processed, failed, dead } }
}
