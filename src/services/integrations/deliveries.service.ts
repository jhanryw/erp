/**
 * Service de Integrações — Event Deliveries (Fase 4).
 *
 * Ciclo de vida REAL por destino, independente entre si (ver justificativa
 * completa em `supabase/migrations/20260818_integration_event_deliveries.sql`).
 * `integration_outbox.status` não representa mais sucesso/falha de um
 * destino específico desde esta fase.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { ServiceOutcome } from '../produtos.service'
import type { OutboxDestination } from './outbox.service'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type DeliveryStatus = 'pending' | 'processing' | 'processed' | 'failed' | 'dead'

export interface EventDelivery {
  id: number
  outbox_event_id: number
  company_id: number
  destination: OutboxDestination
  status: DeliveryStatus
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

/**
 * Backoff fixo e previsível (seção 32 do pedido): tentativa 1 falha → +1min,
 * 2 → +5min, 3 → +15min, 4 → +1h. Depois da 5ª tentativa (`attempts` já
 * incrementado pelo claim), sem mais entradas na tabela → `dead`. Nenhuma
 * dezena de estratégias — só esta constante.
 */
export const DELIVERY_BACKOFF_MINUTES = [1, 5, 15, 60] as const
export const DELIVERY_MAX_ATTEMPTS = DELIVERY_BACKOFF_MINUTES.length + 1 // 5

export function computeNextAvailableAt(attempts: number, nowMs = Date.now()): Date {
  const idx = Math.min(attempts - 1, DELIVERY_BACKOFF_MINUTES.length - 1)
  const delayMinutes = DELIVERY_BACKOFF_MINUTES[Math.max(idx, 0)]
  return new Date(nowMs + delayMinutes * 60_000)
}

// ─── Claim ──────────────────────────────────────────────────────────────────

/**
 * `FOR UPDATE SKIP LOCKED` via `rpc_claim_event_deliveries` — múltiplos
 * workers futuros do mesmo destino nunca reivindicam a mesma linha (ver
 * teste de concorrência em
 * `supabase/tests/integration_event_deliveries_claim.concurrency.md`).
 */
export async function claimEventDeliveries(
  destination: OutboxDestination,
  limit: number,
  workerId: string,
): Promise<ServiceOutcome<EventDelivery[]>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any).rpc('rpc_claim_event_deliveries', {
    p_destination: destination,
    p_limit: limit,
    p_worker_id: workerId,
  }) as { data: EventDelivery[] | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data ?? [])
}

// ─── Transições de estado ───────────────────────────────────────────────────

export async function markDeliveryProcessed(deliveryId: number, companyId: number): Promise<ServiceOutcome<void>> {
  const admin = createAdminClient()
  const { error } = await (admin as any)
    .from('integration_event_deliveries')
    .update({ status: 'processed', processed_at: new Date().toISOString(), locked_at: null, locked_by: null, last_error: null })
    .eq('id', deliveryId)
    .eq('company_id', companyId)

  if (error) return failure(error.message)
  return success(undefined)
}

/**
 * `permanent = true` (seção 33 do pedido — 401/403/404/422, integração
 * inativa, contato não existe mais) pula direto pra `dead`, sem gastar o
 * backoff — retry não teria como ajudar. `retryAfterSeconds` (seção 34 —
 * 429 do Chatwoot) tem prioridade sobre o backoff padrão quando informado.
 */
export async function markDeliveryFailed(
  deliveryId: number,
  companyId: number,
  errorMessage: string,
  options?: { permanent?: boolean; retryAfterSeconds?: number },
): Promise<ServiceOutcome<void>> {
  const admin = createAdminClient()

  const { data: current, error: readError } = await (admin as any)
    .from('integration_event_deliveries')
    .select('attempts')
    .eq('id', deliveryId)
    .eq('company_id', companyId)
    .maybeSingle() as { data: { attempts: number } | null; error: { message: string } | null }

  if (readError) return failure(readError.message)
  if (!current) return failure('Delivery não encontrado.', 404)

  const isDead = options?.permanent || current.attempts >= DELIVERY_MAX_ATTEMPTS

  const patch: Record<string, unknown> = {
    last_error: errorMessage.slice(0, 2000),
    locked_at: null,
    locked_by: null,
  }

  if (isDead) {
    patch.status = 'dead'
  } else {
    patch.status = 'pending' // volta pra fila, disponível depois do backoff
    patch.available_at = options?.retryAfterSeconds
      ? new Date(Date.now() + options.retryAfterSeconds * 1000).toISOString()
      : computeNextAvailableAt(current.attempts).toISOString()
  }

  const { error } = await (admin as any)
    .from('integration_event_deliveries')
    .update(patch)
    .eq('id', deliveryId)
    .eq('company_id', companyId)

  if (error) return failure(error.message)
  return success(undefined)
}
