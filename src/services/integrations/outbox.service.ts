/**
 * Service de Integrações — Outbox (Fase 2).
 *
 * Nenhuma escrita em `integration_outbox` acontece por aqui — eventos
 * nascem DENTRO das RPCs de domínio (`rpc_create_sale`/`cancel`/`return`/
 * `process_exchange`), na mesma transação Postgres, nunca por uma chamada
 * de API separada (ver relatório da Fase 2, seção F — garantia
 * transacional é não-negociável). Este arquivo só tem:
 *   - `buildOutboxEventId`: helper canônico pra NUNCA concatenar
 *     `sale:<id>:completed` manualmente em mais de um lugar do projeto
 *     (mesmo formato usado dentro das RPCs, em SQL — mantidos em sincronia
 *     manualmente, mesma dívida técnica já registrada pro script de
 *     backfill da Fase 1).
 *   - Leitura/claim, só pra observabilidade e teste — NENHUM worker
 *     consome isso nesta fase (proibido explicitamente).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { ServiceOutcome } from '../produtos.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type OutboxEventType = 'sale.completed' | 'sale.cancelled' | 'sale.refunded'
export type OutboxAggregateType = 'sale'
/**
 * Desde a Fase 4: 'dispatched' é o estado final normal de sucesso (fan-out
 * criou as linhas de delivery relevantes) — 'processing'/'processed'/
 * 'failed'/'dead' continuam válidos no banco só por compatibilidade com
 * `rpc_claim_outbox_events`, mas não representam mais o resultado de um
 * destino específico (isso agora vive em `integration_event_deliveries`).
 * Ver `supabase/migrations/20260818_integration_event_deliveries.sql`.
 */
export type OutboxStatus = 'pending' | 'processing' | 'dispatched' | 'processed' | 'failed' | 'dead'

export interface OutboxEvent {
  id: number
  company_id: number
  event_id: string
  event_type: OutboxEventType
  aggregate_type: OutboxAggregateType
  aggregate_id: string
  payload: Record<string, unknown>
  status: OutboxStatus
  attempts: number
  available_at: string
  locked_at: string | null
  locked_by: string | null
  last_error: string | null
  processed_at: string | null
  created_at: string
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

// ─── event_id canônico ──────────────────────────────────────────────────────

/**
 * Formato: `<aggregateType>:<aggregateId>:<evento sem o prefixo do aggregate>`
 * — ex.: `sale:123:completed`. Mesma construção usada dentro das RPCs SQL
 * (`'sale:' || v_sale_id || ':completed'`) — se este helper mudar, as RPCs
 * precisam mudar junto (e vice-versa).
 */
export function buildOutboxEventId(
  aggregateType: OutboxAggregateType,
  aggregateId: string | number,
  eventType: OutboxEventType,
): string {
  const suffix = eventType.startsWith(`${aggregateType}.`) ? eventType.slice(aggregateType.length + 1) : eventType
  return `${aggregateType}:${aggregateId}:${suffix}`
}

// ─── Leitura / observabilidade (sem consumer real nesta fase) ─────────────────

export async function getOutboxEventByEventId(eventId: string): Promise<ServiceOutcome<OutboxEvent | null>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('integration_outbox')
    .select('*')
    .eq('event_id', eventId)
    .maybeSingle() as { data: OutboxEvent | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data)
}

export async function getOutboxEventById(id: number): Promise<ServiceOutcome<OutboxEvent | null>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('integration_outbox')
    .select('*')
    .eq('id', id)
    .maybeSingle() as { data: OutboxEvent | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data)
}

export async function listOutboxEventsForAggregate(
  aggregateType: OutboxAggregateType,
  aggregateId: string | number,
): Promise<ServiceOutcome<OutboxEvent[]>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('integration_outbox')
    .select('*')
    .eq('aggregate_type', aggregateType)
    .eq('aggregate_id', String(aggregateId))
    .order('created_at', { ascending: true }) as { data: OutboxEvent[] | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data ?? [])
}

/**
 * Reivindica até `limit` eventos `pending` via `rpc_claim_outbox_events`
 * (`FOR UPDATE SKIP LOCKED`) — só pra teste/observabilidade nesta fase,
 * nenhum worker real chama isso ainda. Ver
 * supabase/tests/integration_outbox_claim.concurrency.md para o teste de
 * concorrência real (2 terminais).
 */
export async function claimOutboxEvents(
  limit: number,
  workerId: string,
): Promise<ServiceOutcome<OutboxEvent[]>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any).rpc('rpc_claim_outbox_events', {
    p_limit: limit,
    p_worker_id: workerId,
  }) as { data: OutboxEvent[] | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data ?? [])
}

// ─── Fan-out — evento de domínio → deliveries por destino (Fase 4) ────────────

export type OutboxDestination = 'chatwoot' | 'meta' | 'n8n'

/**
 * Único lugar do projeto que decide quais destinos um `event_type` gera —
 * nunca hardcoded dentro de uma RPC de venda (seção 28 do pedido da Fase
 * 4: a RPC de domínio continua só criando `integration_outbox`, fan-out é
 * sempre um passo posterior e desacoplado). Hoje só `chatwoot` tem
 * consumidor real; quando o Meta CAPI (Fase 6) ou um consumer n8n
 * existirem, este é o único ponto que precisa mudar.
 */
function destinationsForEvent(eventType: OutboxEventType): OutboxDestination[] {
  if (eventType === 'sale.completed' || eventType === 'sale.cancelled' || eventType === 'sale.refunded') {
    return ['chatwoot']
  }
  return []
}

export interface FanOutResult {
  claimedEvents: number
  deliveriesCreated: number
}

/**
 * Reivindica eventos `pending` (via `claimOutboxEvents`/`rpc_claim_outbox_events`
 * — reaproveita o `FOR UPDATE SKIP LOCKED` da Fase 2, não duplica lógica de
 * concorrência) e cria as linhas de `integration_event_deliveries`
 * correspondentes. Idempotente: `UNIQUE(outbox_event_id, destination)` faz
 * uma segunda chamada de fan-out pro mesmo evento não duplicar delivery
 * (23505 tratado como já-existente, não erro).
 *
 * NENHUM scheduler chama isso ainda nesta fase (proibido explicitamente) —
 * é uma função pronta pra ser chamada por teste, por invocação manual, ou
 * futuramente por um cron (Fase 5+).
 */
export async function fanOutPendingOutboxEvents(
  limit = 50,
  workerId = 'fanout',
): Promise<ServiceOutcome<FanOutResult>> {
  const admin = createAdminClient()

  const claimResult = await claimOutboxEvents(limit, workerId)
  if (!claimResult.ok) return failure(claimResult.error, claimResult.status)

  let deliveriesCreated = 0

  for (const event of claimResult.data) {
    for (const destination of destinationsForEvent(event.event_type)) {
      const { error: insertError } = await (admin as any).from('integration_event_deliveries').insert({
        outbox_event_id: event.id,
        company_id: event.company_id,
        destination,
      })
      if (!insertError) {
        deliveriesCreated++
      } else if (insertError.code !== '23505') {
        return failure(`Falha ao criar delivery (${destination}) pro evento ${event.event_id}: ${insertError.message}`)
      }
    }

    const { error: dispatchError } = await (admin as any)
      .from('integration_outbox')
      .update({ status: 'dispatched', processed_at: new Date().toISOString() })
      .eq('id', event.id)
    if (dispatchError) return failure(`Falha ao marcar evento ${event.event_id} como dispatched: ${dispatchError.message}`)
  }

  return success({ claimedEvents: claimResult.data.length, deliveriesCreated })
}
