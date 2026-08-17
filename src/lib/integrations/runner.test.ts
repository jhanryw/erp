import { describe, it, expect, vi, afterEach } from 'vitest'
import { runIntegrationOutboxCycle } from './runner'
import * as outboxService from '@/services/integrations/outbox.service'
import * as deliveryConsumer from './chatwoot/deliveryConsumer'

describe('runIntegrationOutboxCycle — orquestração fan-out + consumer (seção 3 do pedido da Fase 5)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('caminho feliz — agrega contadores de fan-out e do consumer chatwoot, inclui duração', async () => {
    vi.spyOn(outboxService, 'fanOutPendingOutboxEvents').mockResolvedValue({ ok: true, data: { claimedEvents: 3, deliveriesCreated: 2 } })
    vi.spyOn(deliveryConsumer, 'consumeChatwootDeliveries').mockResolvedValue({ ok: true, data: { claimed: 2, synced: 1, skipped: 1, failed: 0, dead: 0 } })

    const result = await runIntegrationOutboxCycle('test-worker')

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual({
        eventsFannedOut: 3,
        deliveriesCreated: 2,
        deliveriesClaimed: 2,
        deliveriesSynced: 1,
        deliveriesSkipped: 1,
        deliveriesFailed: 0,
        deliveriesDead: 0,
        durationMs: expect.any(Number),
      })
      expect(result.data.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('fan-out falhou → nem chama o consumer, erro propagado', async () => {
    vi.spyOn(outboxService, 'fanOutPendingOutboxEvents').mockResolvedValue({ ok: false, error: 'rpc_claim_outbox_events indisponível', status: 500 })
    const consumerSpy = vi.spyOn(deliveryConsumer, 'consumeChatwootDeliveries')

    const result = await runIntegrationOutboxCycle('test-worker')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('fan-out falhou')
    expect(consumerSpy).not.toHaveBeenCalled()
  })

  it('fan-out OK mas consumer falhou → erro reportado com números parciais do fan-out preservados (nada perdido silenciosamente)', async () => {
    vi.spyOn(outboxService, 'fanOutPendingOutboxEvents').mockResolvedValue({ ok: true, data: { claimedEvents: 5, deliveriesCreated: 4 } })
    vi.spyOn(deliveryConsumer, 'consumeChatwootDeliveries').mockResolvedValue({ ok: false, error: 'rpc_claim_event_deliveries indisponível' })

    const result = await runIntegrationOutboxCycle('test-worker')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('consumo de deliveries chatwoot falhou')
      expect(result.partial?.eventsFannedOut).toBe(5)
      expect(result.partial?.deliveriesCreated).toBe(4)
    }
  })

  it('passa o mesmo workerId pros dois passos (rastreabilidade de uma execução ponta a ponta)', async () => {
    const fanOutSpy = vi.spyOn(outboxService, 'fanOutPendingOutboxEvents').mockResolvedValue({ ok: true, data: { claimedEvents: 0, deliveriesCreated: 0 } })
    const consumerSpy = vi.spyOn(deliveryConsumer, 'consumeChatwootDeliveries').mockResolvedValue({ ok: true, data: { claimed: 0, synced: 0, skipped: 0, failed: 0, dead: 0 } })

    await runIntegrationOutboxCycle('cron-abc-123')

    expect(fanOutSpy).toHaveBeenCalledWith(expect.any(Number), 'cron-abc-123')
    expect(consumerSpy).toHaveBeenCalledWith(expect.any(Number), 'cron-abc-123')
  })
})
