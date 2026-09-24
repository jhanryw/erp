/**
 * inbound_events — notificações recebidas de canais.
 *
 * Webhook: valida o formato, enfileira (rpc_enqueue_inbound_event resolve
 * empresa/integração pelo user_id do canal) e responde 200 na hora.
 * Worker: claim concorrente (SKIP LOCKED + recuperação de 'processing'
 * preso), relê o recurso na API do canal e processa; falha transitória →
 * backoff; falha permanente ou tentativas esgotadas → dead.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { isMercadoLivreError } from '@/lib/integrations/mercadolivre/errors'
import { parseNotificationResource } from '@/lib/integrations/mercadolivre/orders'
import {
  ChannelOrderError,
  processMercadoLivreOrder,
  processMercadoLivreShipment,
  type ChannelOrdersDeps,
  type ProcessOrderResult,
} from './channelOrders.service'

export interface InboundEventRow {
  id: number
  company_id: number
  integration_id: number
  provider: string
  topic: string
  resource: string
  attempts: number
}

export interface InboundRepo {
  enqueue(input: { provider: string; externalAccountId: string; topic: string; resource: string; dedupKey: string; externalEventId: string | null; payload: Record<string, unknown> }): Promise<{ result: string; event_id?: number }>
  claim(provider: string, limit: number, workerId: string, staleSeconds: number): Promise<InboundEventRow[]>
  finish(eventId: number, workerId: string, status: 'processed' | 'failed' | 'dead', error?: string | null, retryAt?: Date | null): Promise<boolean>
}

/** Tópicos processados na Fase 3 (configurar SOMENTE estes no app do DevCenter). */
export const MERCADOLIVRE_HANDLED_TOPICS = new Set(['orders_v2', 'shipments'])

export const INBOUND_BACKOFF_MINUTES = [1, 5, 15, 60, 180]
export const INBOUND_MAX_ATTEMPTS = 6

export function nextRetryAt(attempts: number, now = Date.now(), retryAfterSeconds?: number | null): Date {
  if (retryAfterSeconds && retryAfterSeconds > 0) return new Date(now + retryAfterSeconds * 1000)
  const idx = Math.min(Math.max(attempts, 1) - 1, INBOUND_BACKOFF_MINUTES.length - 1)
  return new Date(now + INBOUND_BACKOFF_MINUTES[idx] * 60_000)
}

// ─── Webhook: validação + enfileiramento ─────────────────────────────────────

export interface MercadoLivreNotification {
  topic: string
  resource: string
  user_id: string
  application_id: string | null
  _id: string | null
  sent: string | null
  attempts: number | null
}

/** Valida o corpo da notificação do ML. Nunca confia em empresa/ids do corpo além de user_id. */
export function parseMercadoLivreNotification(body: unknown): MercadoLivreNotification | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const topic = typeof b.topic === 'string' ? b.topic.trim() : ''
  const resource = typeof b.resource === 'string' ? b.resource.trim() : ''
  const userId = b.user_id != null ? String(b.user_id).trim() : ''
  if (!/^[a-z0-9_-]{2,60}$/i.test(topic) || !resource || resource.length > 300 || !/^\d{1,20}$/.test(userId)) return null
  return {
    topic,
    resource,
    user_id: userId,
    application_id: b.application_id != null ? String(b.application_id) : null,
    _id: typeof b._id === 'string' ? b._id.slice(0, 100) : typeof b.id === 'string' ? b.id.slice(0, 100) : null,
    sent: typeof b.sent === 'string' ? b.sent.slice(0, 40) : null,
    attempts: typeof b.attempts === 'number' ? b.attempts : null,
  }
}

export type EnqueueOutcome = 'queued' | 'coalesced' | 'ignored_topic' | 'unknown_account' | 'wrong_application'

export async function enqueueMercadoLivreNotification(
  n: MercadoLivreNotification,
  opts: { expectedApplicationId?: string | null; repo?: InboundRepo } = {},
): Promise<EnqueueOutcome> {
  if (opts.expectedApplicationId && n.application_id && n.application_id !== opts.expectedApplicationId) return 'wrong_application'
  if (!MERCADOLIVRE_HANDLED_TOPICS.has(n.topic) || !parseNotificationResource(n.topic, n.resource)) return 'ignored_topic'
  const repo = opts.repo ?? createSupabaseInboundRepo()
  const r = await repo.enqueue({
    provider: 'mercadolivre',
    externalAccountId: n.user_id,
    topic: n.topic,
    resource: n.resource,
    // Coalescência por recurso: notificações repetidas do mesmo pedido/envio
    // viram 1 evento enquanto ele estiver aberto.
    dedupKey: `${n.topic}:${n.resource}`,
    externalEventId: n._id,
    payload: { topic: n.topic, resource: n.resource, user_id: n.user_id, application_id: n.application_id, sent: n.sent, attempts: n.attempts },
  })
  return r.result === 'unknown_account' ? 'unknown_account' : r.result === 'coalesced' ? 'coalesced' : 'queued'
}

// ─── Worker ───────────────────────────────────────────────────────────────────

export interface ProcessInboundResult {
  claimed: number
  processed: number
  failed: number
  dead: number
  stockMayHaveChanged: boolean
  outcomes: Array<{ eventId: number; status: 'processed' | 'failed' | 'dead'; action?: ProcessOrderResult['action']; code?: string | null; error?: string }>
}

export interface InboundWorkerDeps {
  repo?: InboundRepo
  orders?: ChannelOrdersDeps
  processOrder?: typeof processMercadoLivreOrder
  processShipment?: typeof processMercadoLivreShipment
  now?: () => number
  staleSeconds?: number
}

function classify(err: unknown): { permanent: boolean; retryAfterSeconds?: number | null; message: string } {
  if (err instanceof ChannelOrderError) return { permanent: true, message: err.message }
  if (isMercadoLivreError(err)) {
    if (['not_found', 'forbidden', 'bad_request', 'integration_not_found', 'integration_disabled'].includes(err.kind)) {
      return { permanent: true, message: `${err.kind}: ${err.message}` }
    }
    // reauth_required: espera o usuário reconectar (retentativas longas, depois dead).
    return { permanent: false, retryAfterSeconds: err.kind === 'reauth_required' ? 3600 : err.retryAfterSeconds, message: `${err.kind}: ${err.message}` }
  }
  return { permanent: false, message: err instanceof Error ? err.message : 'erro inesperado' }
}

export async function processInboundEvents(workerId: string, limit = 10, deps: InboundWorkerDeps = {}): Promise<ProcessInboundResult> {
  const repo = deps.repo ?? createSupabaseInboundRepo()
  const processOrder = deps.processOrder ?? processMercadoLivreOrder
  const processShipment = deps.processShipment ?? processMercadoLivreShipment
  const now = deps.now ?? Date.now
  const events = await repo.claim('mercadolivre', limit, workerId, deps.staleSeconds ?? 300)
  const out: ProcessInboundResult = { claimed: events.length, processed: 0, failed: 0, dead: 0, stockMayHaveChanged: false, outcomes: [] }

  for (const ev of events) {
    try {
      const target = parseNotificationResource(ev.topic, ev.resource)
      let res: ProcessOrderResult | null = null
      if (target?.kind === 'order') res = await processOrder(ev.company_id, ev.integration_id, target.id, deps.orders)
      else if (target?.kind === 'shipment') res = await processShipment(ev.company_id, ev.integration_id, target.id, deps.orders)
      await repo.finish(ev.id, workerId, 'processed')
      out.processed++
      if (res && (res.action === 'imported' || res.action === 'cancelled')) out.stockMayHaveChanged = true
      out.outcomes.push({ eventId: ev.id, status: 'processed', action: res?.action, code: res?.code ?? null })
    } catch (err) {
      const c = classify(err)
      const dead = c.permanent || ev.attempts >= INBOUND_MAX_ATTEMPTS
      await repo.finish(ev.id, workerId, dead ? 'dead' : 'failed', c.message, dead ? null : nextRetryAt(ev.attempts, now(), c.retryAfterSeconds))
      if (dead) out.dead++
      else out.failed++
      out.outcomes.push({ eventId: ev.id, status: dead ? 'dead' : 'failed', error: c.message })
    }
  }
  return out
}

// ─── Repo de produção ─────────────────────────────────────────────────────────

export function createSupabaseInboundRepo(): InboundRepo {
  const admin = createAdminClient() as any
  return {
    async enqueue(i) {
      const { data, error } = await admin.rpc('rpc_enqueue_inbound_event', {
        p_provider: i.provider, p_external_account_id: i.externalAccountId, p_topic: i.topic, p_resource: i.resource,
        p_dedup_key: i.dedupKey, p_external_event_id: i.externalEventId, p_payload: i.payload,
      })
      if (error) throw new Error(`rpc_enqueue_inbound_event: ${error.message}`)
      return data
    },
    async claim(provider, limit, workerId, staleSeconds) {
      const { data, error } = await admin.rpc('rpc_claim_inbound_events', {
        p_provider: provider, p_limit: limit, p_worker_id: workerId, p_stale_seconds: staleSeconds,
      })
      if (error) throw new Error(`rpc_claim_inbound_events: ${error.message}`)
      return data ?? []
    },
    async finish(eventId, workerId, status, errorText, retryAt) {
      const { data, error } = await admin.rpc('rpc_finish_inbound_event', {
        p_event_id: eventId, p_worker_id: workerId, p_status: status, p_error: errorText ?? null, p_retry_at: retryAt ? retryAt.toISOString() : null,
      })
      if (error) throw new Error(`rpc_finish_inbound_event: ${error.message}`)
      return Boolean(data)
    },
  }
}
