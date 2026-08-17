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

/**
 * Desde a Fase 5: 'skipped' é distinto de 'processed' — ver
 * `supabase/migrations/20260819_integration_event_deliveries_skipped_status.sql`.
 * 'processed' = sincronizado de verdade (ex.: `reconcileCustomerToChatwoot`
 * retornou `synced`). 'skipped' = resultado terminal válido sem nada pra
 * sincronizar (`not_linked`/`no_person`/`ambiguous_person`/
 * `anonymous_customer`/`integration_not_active`) — nunca é retryado, mas
 * também nunca é contado como sucesso de sincronização.
 */
export type DeliveryStatus = 'pending' | 'processing' | 'processed' | 'skipped' | 'failed' | 'dead'

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
 * Terminal, mas NUNCA é sucesso de sincronização nem erro — resultado
 * válido de "não havia o que fazer ainda" (seção 11 do pedido da Fase 5:
 * customer sem contato Chatwoot vinculado, pessoa ambígua, etc.). Nunca
 * agenda retry — a próxima sincronização real acontece por um gatilho
 * diferente (novo evento de venda, ou um futuro `contact_created` que crie
 * o vínculo), nunca por insistir nesta mesma linha de delivery.
 */
export async function markDeliverySkipped(deliveryId: number, companyId: number, reason: string): Promise<ServiceOutcome<void>> {
  const admin = createAdminClient()
  const { error } = await (admin as any)
    .from('integration_event_deliveries')
    .update({ status: 'skipped', processed_at: new Date().toISOString(), locked_at: null, locked_by: null, last_error: reason.slice(0, 2000) })
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

// ─── Dead-letter (seção 20-21 do pedido da Fase 5) ─────────────────────────

/**
 * Consulta pra inspecionar deliveries que esgotaram o backoff (`dead`) —
 * sem UI ainda (não pedido nesta fase), mas server-side pronto pra uso
 * administrativo/futuro. Sempre escopado por `companyId` — nunca lista
 * cross-tenant.
 */
export async function listDeadDeliveries(companyId: number, limit = 50): Promise<ServiceOutcome<EventDelivery[]>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('integration_event_deliveries')
    .select('*')
    .eq('company_id', companyId)
    .eq('status', 'dead')
    .order('created_at', { ascending: false })
    .limit(limit) as { data: EventDelivery[] | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data ?? [])
}

/**
 * Reenfileira uma delivery `dead` (ou `failed`) manualmente. Semântica de
 * `attempts` (seção 21 do pedido, decisão explícita): por padrão PRESERVA
 * `attempts` — um requeue não é um novo orçamento de 5 tentativas do zero,
 * é "tente de novo agora"; sem isso, requeues repetidos poderiam martelar
 * um destino indefinidamente contornando o dead-letter. Passe
 * `resetAttempts: true` só quando a causa raiz foi corrigida de verdade
 * (ex.: integração reativada, token trocado) e um orçamento novo de
 * tentativas é justificado.
 */
export async function requeueDelivery(
  deliveryId: number,
  companyId: number,
  options?: { resetAttempts?: boolean },
): Promise<ServiceOutcome<void>> {
  const admin = createAdminClient()
  const patch: Record<string, unknown> = {
    status: 'pending',
    available_at: new Date().toISOString(),
    locked_at: null,
    locked_by: null,
  }
  if (options?.resetAttempts) patch.attempts = 0

  const { error } = await (admin as any)
    .from('integration_event_deliveries')
    .update(patch)
    .eq('id', deliveryId)
    .eq('company_id', companyId)

  if (error) return failure(error.message)
  return success(undefined)
}
