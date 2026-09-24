import { describe, it, expect, vi, beforeEach } from 'vitest'

const inbound = vi.hoisted(() => ({ enqueue: vi.fn(), cycle: vi.fn() }))

vi.mock('@/services/channels/inboundEvents.service', async (orig) => {
  const real = await orig<typeof import('@/services/channels/inboundEvents.service')>()
  return { ...real, enqueueMercadoLivreNotification: inbound.enqueue }
})
vi.mock('@/services/channels/inboundCycle.service', () => ({ runInboundCycle: inbound.cycle }))

import { POST } from './route'

const req = (body: unknown) => new Request('https://santtorini.qarvon.com/api/webhooks/mercadolivre', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' },
})
const note = { resource: '/orders/2000001', user_id: 555, topic: 'orders_v2', application_id: 123, attempts: 1, sent: '2026-09-24T13:00:00Z' }

beforeEach(() => {
  vi.clearAllMocks()
  inbound.cycle.mockResolvedValue({ inbound: {}, fanout: null })
  process.env.MERCADOLIVRE_CLIENT_ID = '123'
})

describe('POST /api/webhooks/mercadolivre', () => {
  it('enfileira e responde 200 sem esperar o processamento (que roda depois)', async () => {
    inbound.enqueue.mockResolvedValue('queued')
    let release!: () => void
    inbound.cycle.mockReturnValue(new Promise((r) => { release = () => r({}) }))
    const t0 = Date.now()
    const res = await POST(req(note))
    expect(res.status).toBe(200)
    expect(Date.now() - t0).toBeLessThan(500)
    expect(await res.json()).toEqual({ ok: true, outcome: 'queued' })
    expect(inbound.enqueue).toHaveBeenCalledWith(expect.objectContaining({ user_id: '555', topic: 'orders_v2' }), { expectedApplicationId: '123' })
    expect(inbound.cycle).toHaveBeenCalledTimes(1)
    release()
  })

  it('duplicata coalescida também responde 200', async () => {
    inbound.enqueue.mockResolvedValue('coalesced')
    expect((await POST(req(note))).status).toBe(200)
  })

  it('conta desconhecida / tópico não tratado / outro app → 200 sem processar (não desativa tópicos)', async () => {
    for (const outcome of ['unknown_account', 'ignored_topic', 'wrong_application']) {
      inbound.enqueue.mockResolvedValueOnce(outcome)
      const res = await POST(req(note))
      expect(res.status).toBe(200)
    }
    expect(inbound.cycle).not.toHaveBeenCalled()
  })

  it('corpo inválido → 400; falha ao persistir → 500 (o ML reenvia)', async () => {
    expect((await POST(req('{nao json'))).status).toBe(400)
    expect((await POST(req({ topic: 'orders_v2' }))).status).toBe(400)
    inbound.enqueue.mockRejectedValue(new Error('db fora'))
    expect((await POST(req(note))).status).toBe(500)
  })

  it('resposta nunca ecoa dados do pedido', async () => {
    inbound.enqueue.mockResolvedValue('queued')
    const body = JSON.stringify(await (await POST(req(note))).json())
    expect(body).not.toMatch(/2000001|555/)
  })
})
