/**
 * Runner do ciclo integration_outbox → integration_event_deliveries →
 * consumers (Fase 5). Orquestra, numa única execução em lote limitado
 * (seção 3 do pedido):
 *   1-3. fan-out (busca eventos pendentes, cria deliveries relevantes,
 *        marca evento como distribuído) — `fanOutPendingOutboxEvents`,
 *        já existente desde a Fase 4, reaproveitado sem alteração de
 *        lógica de concorrência.
 *   4-6. claim + processa deliveries `chatwoot` pendentes + atualiza
 *        status/retry — `consumeChatwootDeliveries`, Fase 4/5.
 *
 * Regra arquitetural inegociável (seção 1 do pedido): este é o runner
 * NATIVO do Qarvon — n8n nunca decide fan-out/claim/retry/backoff/
 * dead-letter. Quem chama este módulo (a rota de cron, seção B do
 * relatório) é o único ponto que decide QUANDO rodar; este arquivo só
 * decide O QUE acontece numa execução.
 *
 * Nenhuma chamada ao Chatwoot acontece dentro da transação de uma venda —
 * este módulo só é invocado depois, por um processo separado (cron),
 * nunca de dentro de `POST /api/vendas` (seção 17 do pedido).
 */

import { fanOutPendingOutboxEvents } from '@/services/integrations/outbox.service'
import { consumeChatwootDeliveries } from './chatwoot/deliveryConsumer'
import { OUTBOX_FANOUT_BATCH_SIZE, CHATWOOT_DELIVERY_BATCH_SIZE } from './runnerConfig'

export interface RunIntegrationOutboxCycleResult {
  eventsFannedOut: number
  deliveriesCreated: number
  deliveriesClaimed: number
  deliveriesSynced: number
  deliveriesSkipped: number
  deliveriesFailed: number
  deliveriesDead: number
  durationMs: number
}

export type RunIntegrationOutboxCycleOutcome =
  | { ok: true; data: RunIntegrationOutboxCycleResult }
  | { ok: false; error: string; partial?: RunIntegrationOutboxCycleResult }

export async function runIntegrationOutboxCycle(workerId: string): Promise<RunIntegrationOutboxCycleOutcome> {
  const start = Date.now()

  const fanOutResult = await fanOutPendingOutboxEvents(OUTBOX_FANOUT_BATCH_SIZE, workerId)
  if (!fanOutResult.ok) {
    return { ok: false, error: `fan-out falhou: ${fanOutResult.error}` }
  }

  const chatwootResult = await consumeChatwootDeliveries(CHATWOOT_DELIVERY_BATCH_SIZE, workerId)
  if (!chatwootResult.ok) {
    // Fan-out já commitou com sucesso (eventos != perdidos) — só o consumo
    // de deliveries falhou. Reporta parcial em vez de fingir que nada rodou.
    return {
      ok: false,
      error: `consumo de deliveries chatwoot falhou: ${chatwootResult.error}`,
      partial: {
        eventsFannedOut: fanOutResult.data.claimedEvents,
        deliveriesCreated: fanOutResult.data.deliveriesCreated,
        deliveriesClaimed: 0,
        deliveriesSynced: 0,
        deliveriesSkipped: 0,
        deliveriesFailed: 0,
        deliveriesDead: 0,
        durationMs: Date.now() - start,
      },
    }
  }

  return {
    ok: true,
    data: {
      eventsFannedOut: fanOutResult.data.claimedEvents,
      deliveriesCreated: fanOutResult.data.deliveriesCreated,
      deliveriesClaimed: chatwootResult.data.claimed,
      deliveriesSynced: chatwootResult.data.synced,
      deliveriesSkipped: chatwootResult.data.skipped,
      deliveriesFailed: chatwootResult.data.failed,
      deliveriesDead: chatwootResult.data.dead,
      durationMs: Date.now() - start,
    },
  }
}
