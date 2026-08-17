import { describe, it, expect, vi, afterEach } from 'vitest'
import { consumeChatwootDeliveries } from './deliveryConsumer'
import * as deliveriesService from '@/services/integrations/deliveries.service'
import * as outboxService from '@/services/integrations/outbox.service'
import * as reconciliation from './reconciliation'

function delivery(overrides: Partial<deliveriesService.EventDelivery> = {}): deliveriesService.EventDelivery {
  return {
    id: 1,
    outbox_event_id: 100,
    company_id: 1,
    destination: 'chatwoot',
    status: 'processing',
    attempts: 1,
    available_at: new Date().toISOString(),
    locked_at: new Date().toISOString(),
    locked_by: 'test-worker',
    last_error: null,
    processed_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function outboxEvent(overrides: Partial<outboxService.OutboxEvent> = {}): outboxService.OutboxEvent {
  return {
    id: 100,
    company_id: 1,
    event_id: 'sale:1:completed',
    event_type: 'sale.completed',
    aggregate_type: 'sale',
    aggregate_id: '1',
    payload: { sale_id: 1, customer_id: 42, total: 100 },
    status: 'dispatched',
    attempts: 1,
    available_at: new Date().toISOString(),
    locked_at: null,
    locked_by: null,
    last_error: null,
    processed_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('consumeChatwootDeliveries — classificação de resultado (seções 10-14/24-26 do pedido da Fase 5)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reconciliação "synced" → markDeliveryProcessed, contado como synced', async () => {
    vi.spyOn(deliveriesService, 'claimEventDeliveries').mockResolvedValue({ ok: true, data: [delivery()] })
    vi.spyOn(outboxService, 'getOutboxEventById').mockResolvedValue({ ok: true, data: outboxEvent() })
    vi.spyOn(reconciliation, 'reconcileCustomerToChatwoot').mockResolvedValue({ ok: true, data: { status: 'synced', contactId: '999' } })
    const processedSpy = vi.spyOn(deliveriesService, 'markDeliveryProcessed').mockResolvedValue({ ok: true, data: undefined })

    const result = await consumeChatwootDeliveries(10, 'test-worker')

    expect(result).toEqual({ ok: true, data: { claimed: 1, synced: 1, skipped: 0, failed: 0, dead: 0 } })
    expect(processedSpy).toHaveBeenCalledWith(1, 1)
  })

  it('seção 25 — customer sem contato Chatwoot vinculado (not_linked) → skip, NUNCA retry', async () => {
    vi.spyOn(deliveriesService, 'claimEventDeliveries').mockResolvedValue({ ok: true, data: [delivery()] })
    vi.spyOn(outboxService, 'getOutboxEventById').mockResolvedValue({ ok: true, data: outboxEvent() })
    vi.spyOn(reconciliation, 'reconcileCustomerToChatwoot').mockResolvedValue({ ok: true, data: { status: 'not_linked' } })
    const skippedSpy = vi.spyOn(deliveriesService, 'markDeliverySkipped').mockResolvedValue({ ok: true, data: undefined })
    const failedSpy = vi.spyOn(deliveriesService, 'markDeliveryFailed').mockResolvedValue({ ok: true, data: undefined })

    const result = await consumeChatwootDeliveries(10, 'test-worker')

    expect(result).toEqual({ ok: true, data: { claimed: 1, synced: 0, skipped: 1, failed: 0, dead: 0 } })
    expect(skippedSpy).toHaveBeenCalledOnce()
    expect(failedSpy).not.toHaveBeenCalled() // nunca vira retry
  })

  it('demais desfechos "nada a sincronizar" (no_person/ambiguous_person/anonymous_customer/integration_not_active) também são skip', async () => {
    for (const status of ['no_person', 'ambiguous_person', 'anonymous_customer', 'integration_not_active'] as const) {
      vi.restoreAllMocks()
      vi.spyOn(deliveriesService, 'claimEventDeliveries').mockResolvedValue({ ok: true, data: [delivery()] })
      vi.spyOn(outboxService, 'getOutboxEventById').mockResolvedValue({ ok: true, data: outboxEvent() })
      vi.spyOn(reconciliation, 'reconcileCustomerToChatwoot').mockResolvedValue({ ok: true, data: { status } })
      const skippedSpy = vi.spyOn(deliveriesService, 'markDeliverySkipped').mockResolvedValue({ ok: true, data: undefined })

      const result = await consumeChatwootDeliveries(10, 'test-worker')

      expect(result.ok && result.data.skipped).toBe(1)
      expect(skippedSpy).toHaveBeenCalledOnce()
    }
  })

  it('seção 24 — Chatwoot indisponível (503 → retryable_error) → failed, backoff agendado, NUNCA dead na 1ª falha', async () => {
    vi.spyOn(deliveriesService, 'claimEventDeliveries').mockResolvedValue({ ok: true, data: [delivery({ attempts: 1 })] })
    vi.spyOn(outboxService, 'getOutboxEventById').mockResolvedValue({ ok: true, data: outboxEvent() })
    vi.spyOn(reconciliation, 'reconcileCustomerToChatwoot').mockResolvedValue({
      ok: true,
      data: { status: 'retryable_error', message: 'Chatwoot respondeu 503' },
    })
    const failedSpy = vi.spyOn(deliveriesService, 'markDeliveryFailed').mockResolvedValue({ ok: true, data: undefined })

    const result = await consumeChatwootDeliveries(10, 'test-worker')

    expect(result).toEqual({ ok: true, data: { claimed: 1, synced: 0, skipped: 0, failed: 1, dead: 0 } })
    expect(failedSpy).toHaveBeenCalledWith(1, 1, 'Chatwoot respondeu 503', { retryAfterSeconds: undefined })
  })

  it('seção 13 — 429 com Retry-After é repassado pro backoff', async () => {
    vi.spyOn(deliveriesService, 'claimEventDeliveries').mockResolvedValue({ ok: true, data: [delivery()] })
    vi.spyOn(outboxService, 'getOutboxEventById').mockResolvedValue({ ok: true, data: outboxEvent() })
    vi.spyOn(reconciliation, 'reconcileCustomerToChatwoot').mockResolvedValue({
      ok: true,
      data: { status: 'retryable_error', message: 'Chatwoot respondeu 429', retryAfterSeconds: 30 },
    })
    const failedSpy = vi.spyOn(deliveriesService, 'markDeliveryFailed').mockResolvedValue({ ok: true, data: undefined })

    await consumeChatwootDeliveries(10, 'test-worker')

    expect(failedSpy).toHaveBeenCalledWith(1, 1, 'Chatwoot respondeu 429', { retryAfterSeconds: 30 })
  })

  it('erro permanente (401/403/404/422/400) → dead imediatamente, sem gastar backoff', async () => {
    vi.spyOn(deliveriesService, 'claimEventDeliveries').mockResolvedValue({ ok: true, data: [delivery()] })
    vi.spyOn(outboxService, 'getOutboxEventById').mockResolvedValue({ ok: true, data: outboxEvent() })
    vi.spyOn(reconciliation, 'reconcileCustomerToChatwoot').mockResolvedValue({
      ok: true,
      data: { status: 'permanent_error', message: 'Chatwoot respondeu 401' },
    })
    const failedSpy = vi.spyOn(deliveriesService, 'markDeliveryFailed').mockResolvedValue({ ok: true, data: undefined })

    const result = await consumeChatwootDeliveries(10, 'test-worker')

    expect(result).toEqual({ ok: true, data: { claimed: 1, synced: 0, skipped: 0, failed: 0, dead: 1 } })
    expect(failedSpy).toHaveBeenCalledWith(1, 1, 'Chatwoot respondeu 401', { permanent: true })
  })

  it('falha de infraestrutura nossa (reconcile ok:false) → retryable, nunca dead direto', async () => {
    vi.spyOn(deliveriesService, 'claimEventDeliveries').mockResolvedValue({ ok: true, data: [delivery()] })
    vi.spyOn(outboxService, 'getOutboxEventById').mockResolvedValue({ ok: true, data: outboxEvent() })
    vi.spyOn(reconciliation, 'reconcileCustomerToChatwoot').mockResolvedValue({ ok: false, error: 'Postgres indisponível', status: 500 })
    const failedSpy = vi.spyOn(deliveriesService, 'markDeliveryFailed').mockResolvedValue({ ok: true, data: undefined })

    const result = await consumeChatwootDeliveries(10, 'test-worker')

    expect(result).toEqual({ ok: true, data: { claimed: 1, synced: 0, skipped: 0, failed: 1, dead: 0 } })
    expect(failedSpy).toHaveBeenCalledWith(1, 1, 'Postgres indisponível')
  })

  it('evento de outbox associado não encontrado → dead (situação impossível/corrompida, não adianta retry)', async () => {
    vi.spyOn(deliveriesService, 'claimEventDeliveries').mockResolvedValue({ ok: true, data: [delivery()] })
    vi.spyOn(outboxService, 'getOutboxEventById').mockResolvedValue({ ok: true, data: null })
    const failedSpy = vi.spyOn(deliveriesService, 'markDeliveryFailed').mockResolvedValue({ ok: true, data: undefined })

    const result = await consumeChatwootDeliveries(10, 'test-worker')

    expect(result).toEqual({ ok: true, data: { claimed: 1, synced: 0, skipped: 0, failed: 0, dead: 1 } })
    expect(failedSpy).toHaveBeenCalledWith(1, 1, expect.any(String), { permanent: true })
  })

  it('payload sem customer_id (venda de cliente anônimo) → skip, nunca chama reconcileCustomerToChatwoot', async () => {
    vi.spyOn(deliveriesService, 'claimEventDeliveries').mockResolvedValue({ ok: true, data: [delivery()] })
    vi.spyOn(outboxService, 'getOutboxEventById').mockResolvedValue({ ok: true, data: outboxEvent({ payload: { sale_id: 1 } }) })
    const reconcileSpy = vi.spyOn(reconciliation, 'reconcileCustomerToChatwoot')
    const skippedSpy = vi.spyOn(deliveriesService, 'markDeliverySkipped').mockResolvedValue({ ok: true, data: undefined })

    const result = await consumeChatwootDeliveries(10, 'test-worker')

    expect(result).toEqual({ ok: true, data: { claimed: 1, synced: 0, skipped: 1, failed: 0, dead: 0 } })
    expect(skippedSpy).toHaveBeenCalledOnce()
    expect(reconcileSpy).not.toHaveBeenCalled()
  })

  it('nenhuma delivery pendente → todos os contadores zerados, nenhuma chamada extra', async () => {
    vi.spyOn(deliveriesService, 'claimEventDeliveries').mockResolvedValue({ ok: true, data: [] })
    const eventSpy = vi.spyOn(outboxService, 'getOutboxEventById')

    const result = await consumeChatwootDeliveries(10, 'test-worker')

    expect(result).toEqual({ ok: true, data: { claimed: 0, synced: 0, skipped: 0, failed: 0, dead: 0 } })
    expect(eventSpy).not.toHaveBeenCalled()
  })

  it('falha do claim propaga como erro, não lança exceção', async () => {
    vi.spyOn(deliveriesService, 'claimEventDeliveries').mockResolvedValue({ ok: false, error: 'RPC indisponível', status: 500 })

    const result = await consumeChatwootDeliveries(10, 'test-worker')

    expect(result).toEqual({ ok: false, error: 'RPC indisponível' })
  })
})
