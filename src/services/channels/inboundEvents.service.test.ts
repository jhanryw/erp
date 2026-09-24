import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  INBOUND_MAX_ATTEMPTS,
  enqueueMercadoLivreNotification,
  nextRetryAt,
  parseMercadoLivreNotification,
  processInboundEvents,
  type InboundEventRow,
  type InboundRepo,
} from './inboundEvents.service'
import { runStockChannelFanout } from './stockFanout.service'
import { ChannelOrderError } from './channelOrders.service'
import { MercadoLivreError } from '@/lib/integrations/mercadolivre/errors'

const note = { topic: 'orders_v2', resource: '/orders/2000001', user_id: 555, application_id: 5503910054141466, attempts: 1, sent: '2026-09-24T13:00:00Z', _id: 'abc' }

describe('notificação do ML', () => {
  it('valida o formato; nada além de user_id identifica a conta', () => {
    expect(parseMercadoLivreNotification(note)).toMatchObject({ topic: 'orders_v2', resource: '/orders/2000001', user_id: '555', application_id: '5503910054141466' })
    expect(parseMercadoLivreNotification({ ...note, user_id: 'abc' })).toBeNull()
    expect(parseMercadoLivreNotification({ ...note, topic: '' })).toBeNull()
    expect(parseMercadoLivreNotification('x')).toBeNull()
  })

  it('enfileira só tópicos tratados, do app certo; coalescência vem do banco', async () => {
    const enqueue = vi.fn(async (): Promise<{ result: string; event_id?: number }> => ({ result: 'queued', event_id: 1 }))
    const repo = { enqueue } as unknown as InboundRepo
    const n = parseMercadoLivreNotification(note)!
    expect(await enqueueMercadoLivreNotification(n, { repo, expectedApplicationId: '5503910054141466' })).toBe('queued')
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ provider: 'mercadolivre', externalAccountId: '555', dedupKey: 'orders_v2:/orders/2000001' }))
    expect(await enqueueMercadoLivreNotification(n, { repo, expectedApplicationId: '999' })).toBe('wrong_application')
    expect(await enqueueMercadoLivreNotification({ ...n, topic: 'items', resource: '/items/MLB1' }, { repo })).toBe('ignored_topic')
    expect(await enqueueMercadoLivreNotification({ ...n, topic: 'payments', resource: '/collections/1' }, { repo })).toBe('ignored_topic')
    enqueue.mockResolvedValueOnce({ result: 'coalesced', event_id: 1 })
    expect(await enqueueMercadoLivreNotification(n, { repo })).toBe('coalesced')
    enqueue.mockResolvedValueOnce({ result: 'unknown_account' })
    expect(await enqueueMercadoLivreNotification(n, { repo })).toBe('unknown_account')
    expect(enqueue).toHaveBeenCalledTimes(3)
  })
})

describe('worker de inbound_events', () => {
  let events: InboundEventRow[]
  let finish: ReturnType<typeof vi.fn>
  const repo = () => ({ enqueue: vi.fn(), claim: vi.fn(async () => events), finish }) as unknown as InboundRepo
  const ev = (over: Partial<InboundEventRow> = {}): InboundEventRow => ({ id: 1, company_id: 10, integration_id: 7, provider: 'mercadolivre', topic: 'orders_v2', resource: '/orders/2000001', attempts: 1, ...over })

  beforeEach(() => {
    events = [ev()]
    finish = vi.fn(async () => true)
  })

  it('roteia pedido e envio para o processador com a empresa/integração DO EVENTO', async () => {
    events = [ev(), ev({ id: 2, topic: 'shipments', resource: '/shipments/44001' })]
    const processOrder = vi.fn(async () => ({ channelOrderId: 1, action: 'imported' as const, saleId: 5 }))
    const processShipment = vi.fn(async () => ({ channelOrderId: 1, action: 'costs_synced' as const }))
    const r = await processInboundEvents('w1', 10, { repo: repo(), processOrder, processShipment })
    expect(processOrder).toHaveBeenCalledWith(10, 7, '2000001', undefined)
    expect(processShipment).toHaveBeenCalledWith(10, 7, '44001', undefined)
    expect(r).toMatchObject({ claimed: 2, processed: 2, stockMayHaveChanged: true })
    expect(finish).toHaveBeenCalledWith(1, 'w1', 'processed')
  })

  it('falha transitória → failed com backoff; 429 respeita retry-after', async () => {
    const processOrder = vi.fn(async () => { throw new MercadoLivreError('rate_limited', 'x', { httpStatus: 429, retryAfterSeconds: 30 }) })
    const now = 1_000_000
    const r = await processInboundEvents('w1', 10, { repo: repo(), processOrder, now: () => now })
    expect(r.failed).toBe(1)
    expect(finish.mock.calls[0][2]).toBe('failed')
    expect((finish.mock.calls[0][4] as Date).getTime()).toBe(now + 30_000)
  })

  it('reautorização pendente → retry longo (1h), não dead imediato', async () => {
    const processOrder = vi.fn(async () => { throw new MercadoLivreError('reauth_required', 'x') })
    await processInboundEvents('w1', 10, { repo: repo(), processOrder, now: () => 0 })
    expect(finish.mock.calls[0][2]).toBe('failed')
    expect((finish.mock.calls[0][4] as Date).getTime()).toBe(3_600_000)
  })

  it('erro permanente (integração inexistente / 404) → dead; tentativas esgotadas → dead', async () => {
    let processOrder = vi.fn(async () => { throw new ChannelOrderError('integration_not_found', 'x') })
    await processInboundEvents('w1', 10, { repo: repo(), processOrder })
    expect(finish.mock.calls[0][2]).toBe('dead')
    finish.mockClear()
    events = [ev({ attempts: INBOUND_MAX_ATTEMPTS })]
    processOrder = vi.fn(async () => { throw new Error('db fora') })
    const r = await processInboundEvents('w1', 10, { repo: repo(), processOrder })
    expect(r.dead).toBe(1)
    expect(finish.mock.calls[0][2]).toBe('dead')
  })

  it('backoff cresce e satura', () => {
    expect(nextRetryAt(1, 0).getTime()).toBe(60_000)
    expect(nextRetryAt(2, 0).getTime()).toBe(300_000)
    expect(nextRetryAt(99, 0).getTime()).toBe(180 * 60_000)
  })
})

describe('fan-out de estoque (stock.changed → canais)', () => {
  it('Nuvemshop recebe as variações alteradas; anúncios pendentes enviam só quantidade; marca limpa antes e restaurada em falha', async () => {
    const pending = new Map<number, boolean>([[1, true], [2, true]])
    const pushNuvemshop = vi.fn(async () => {})
    const syncQuantity = vi.fn(async (_c: number, id: number) => { if (id === 2) throw new Error('ML 503') })
    const r = await runStockChannelFanout('w', 10, {
      processAvailability: async () => ({ ok: true, changedVariationIds: [11, 12] }),
      pushNuvemshop,
      listPending: async () => [{ id: 1, company_id: 10 }, { id: 2, company_id: 10 }],
      setPending: async (id, v) => { pending.set(id, v) },
      syncQuantity,
    })
    expect(pushNuvemshop).toHaveBeenCalledWith([11, 12])
    expect(r).toMatchObject({ changedVariations: 2, listingsSynced: 1, listingsFailed: 1 })
    expect(pending.get(1)).toBe(false)
    expect(pending.get(2)).toBe(true)
  })

  it('nada mudou → nenhum push', async () => {
    const pushNuvemshop = vi.fn(async () => {})
    await runStockChannelFanout('w', 10, {
      processAvailability: async () => ({ ok: true, changedVariationIds: [] }),
      pushNuvemshop, listPending: async () => [], setPending: async () => {}, syncQuantity: async () => {},
    })
    expect(pushNuvemshop).not.toHaveBeenCalled()
  })
})
