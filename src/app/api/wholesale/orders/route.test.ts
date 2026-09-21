import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveWholesalePublicContext } from '@/lib/wholesale/publicContext'
import { createWholesaleOrder } from '@/services/wholesale/orders'
import * as routeModule from './route'
import { POST } from './route'

vi.mock('@/lib/wholesale/publicContext', async (orig) => ({ ...(await orig<any>()), resolveWholesalePublicContext: vi.fn() }))
vi.mock('@/lib/errors/log', () => ({ logError: vi.fn() }))
vi.mock('@/services/wholesale/orders', async (orig) => ({ ...(await orig<any>()), createWholesaleOrder: vi.fn() }))

const KEY = '11111111-1111-4111-8111-111111111111'
const valid = () => ({ idempotency_key: KEY, customer: { name: 'Maria Silva', phone: '84999999999' }, items: [{ variation_id: 10, quantity: 3 }] })
const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://x/api/wholesale/orders', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

const persisted = {
  id: 'internal-uuid', code: 'AT-000184', status: 'pending', customerName: 'Maria Silva', customerPhone: '+5584999999999',
  totalItems: 5, subtotal: 154.5, minimumOrderAmount: 100, saleId: null, createdAt: '', updatedAt: '',
  items: [
    { position: 1, variationId: 10, productId: 1, productName: 'Conjunto Nuance', sku: 'NUA-M-PRETO', attributes: [{ type: 'Tamanho', value: 'M' }], quantity: 2, unitPrice: 39.9, subtotal: 79.8 },
    { position: 2, variationId: 11, productId: 2, productName: 'Sutiã Reforçado', sku: 'SR-G-BEGE', attributes: [{ type: 'Tamanho', value: 'G' }], quantity: 3, unitPrice: 24.9, subtotal: 74.7 },
  ],
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(resolveWholesalePublicContext as any).mockResolvedValue({ ok: true, companyId: 7, settings: { catalogActive: true, whatsappPhone: '84988887777' } })
  ;(createWholesaleOrder as any).mockResolvedValue({ ok: true, replay: false, order: persisted })
})

describe('POST /api/wholesale/orders', () => {
  it('não existe leitura pública: a rota só exporta POST (sem GET/PUT/DELETE)', () => {
    expect(Object.keys(routeModule).filter((k) => ['GET', 'PUT', 'PATCH', 'DELETE'].includes(k))).toEqual([])
  })

  it('catálogo desligado → 503 e nada é criado', async () => {
    ;(resolveWholesalePublicContext as any).mockResolvedValue({ ok: false, status: 503, error: 'Catálogo temporariamente indisponível.' })
    expect((await POST(req(valid()))).status).toBe(503)
    expect(createWholesaleOrder).not.toHaveBeenCalled()
  })

  it('cria (201) usando a empresa do TENANT e só id+quantidade dos itens', async () => {
    const res = await POST(req(valid(), { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }))
    expect(res.status).toBe(201)
    expect(createWholesaleOrder).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 7, idempotencyKey: KEY, items: [{ variationId: 10, quantity: 3 }], clientIp: '203.0.113.5',
      customer: { name: 'Maria Silva', phone: '84999999999' },
    }))
  })

  it.each([
    ['company_id', { company_id: 99 }],
    ['preço no item', { items: [{ variation_id: 10, quantity: 3, unit_price: 0.01 }] }],
    ['nome no item', { items: [{ variation_id: 10, quantity: 3, name: 'HACK' }] }],
    ['SKU no item', { items: [{ variation_id: 10, quantity: 3, sku: 'HACK' }] }],
    ['total', { total: 1 }],
    ['subtotal', { subtotal: 1 }],
    ['documento no cliente', { customer: { name: 'Ana Souza', phone: '84999999999', cpf: '123' } }],
  ])('rejeita campo não permitido (%s) com 422, sem criar pedido', async (_n, extra) => {
    const res = await POST(req({ ...valid(), ...extra }))
    expect(res.status).toBe(422)
    expect(createWholesaleOrder).not.toHaveBeenCalled()
  })

  it('valida payload: chave, quantidade, lista vazia, itens demais, JSON inválido, corpo enorme', async () => {
    expect((await POST(req({ ...valid(), idempotency_key: 'abc' }))).status).toBe(422)
    expect((await POST(req({ ...valid(), items: [{ variation_id: 10, quantity: 0 }] }))).status).toBe(422)
    expect((await POST(req({ ...valid(), items: [] }))).status).toBe(422)
    expect((await POST(req({ ...valid(), items: Array.from({ length: 201 }, (_, i) => ({ variation_id: i + 1, quantity: 1 })) }))).status).toBe(422)
    expect((await POST(req('{nope'))).status).toBe(400)
    expect((await POST(req('x'.repeat(100_001)))).status).toBe(413)
    expect(createWholesaleOrder).not.toHaveBeenCalled()
  })

  it('resposta pública NÃO traz dados pessoais nem id interno; traz código, totais e itens', async () => {
    const body = await (await POST(req(valid()))).json()
    // O `order` público não carrega dados pessoais nem o id interno (a URL do WhatsApp leva o nome/telefone
    // do próprio comprador na mensagem que ELE envia — é o propósito dela).
    expect(JSON.stringify(body.order)).not.toMatch(/Maria|5584999999999|84999999999|internal-uuid|customer/i)
    expect(Object.keys(body).sort()).toEqual(['order', 'replay', 'whatsappUrl'])
    expect(body.order).toMatchObject({ code: 'AT-000184', totalItems: 5, subtotal: 154.5 })
    expect(body.order).not.toHaveProperty('id')
    expect(body.order).not.toHaveProperty('customerName')
    expect(body.order).not.toHaveProperty('customerPhone')
  })

  it('whatsappUrl vem do pedido PERSISTIDO: SKU, atributos, quantidades, subtotais, total e código; destino = WhatsApp da empresa', async () => {
    const body = await (await POST(req(valid()))).json()
    expect(body.whatsappUrl.startsWith('https://wa.me/5584988887777?text=')).toBe(true)
    const message = decodeURIComponent(body.whatsappUrl.split('?text=')[1])
    expect(message).toContain('PEDIDO ATACADO — AT-000184')
    expect(message).toContain('SKU: NUA-M-PRETO')
    expect(message).toContain('Tamanho: G')
    expect(message).toContain('2 un. × R$ 39,90')
    expect(message).toContain('Subtotal: R$ 74,70')
    expect(message).toContain('Total de peças: 5')
    expect(message).toContain('Total do pedido: R$ 154,50')
    expect(message).toContain('Código do pedido: AT-000184')
  })

  it('retry idempotente → 200 (replay) com o mesmo código', async () => {
    ;(createWholesaleOrder as any).mockResolvedValue({ ok: true, replay: true, order: persisted })
    const res = await POST(req(valid()))
    expect(res.status).toBe(200)
    expect((await res.json()).order.code).toBe('AT-000184')
  })

  it('repassa erros estruturados: mínimo (422), itens (409), spam (429)', async () => {
    ;(createWholesaleOrder as any).mockResolvedValueOnce({ ok: false, status: 422, error: 'below_minimum', message: 'm', minimumOrder: 300, currentTotal: 245, missingAmount: 55 })
    const r1 = await POST(req(valid()))
    expect(r1.status).toBe(422)
    expect(await r1.json()).toMatchObject({ error: 'below_minimum', minimumOrder: 300, currentTotal: 245, missingAmount: 55 })

    ;(createWholesaleOrder as any).mockResolvedValueOnce({ ok: false, status: 409, error: 'items_unavailable', message: 'm', validation: { valid: false, items: [], summary: {} } })
    expect((await POST(req(valid()))).status).toBe(409)

    ;(createWholesaleOrder as any).mockResolvedValueOnce({ ok: false, status: 429, error: 'rate_limited', message: 'm' })
    expect((await POST(req(valid()))).status).toBe(429)
  })

  it('exige Content-Type application/json (POST cross-site text/plain não passa) → 415', async () => {
    const res = await POST(new Request('http://x', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(valid()) }))
    expect(res.status).toBe(415)
    expect(createWholesaleOrder).not.toHaveBeenCalled()
  })

  it('falha inesperada → 500 genérico (sem texto técnico), com log sem dados pessoais', async () => {
    const { logError } = await import('@/lib/errors/log')
    ;(createWholesaleOrder as any).mockRejectedValue(new Error('connection reset by peer (host=db.internal)'))
    const res = await POST(req(valid()))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toMatch(/db\.internal|connection reset/)
    const logged = JSON.stringify((logError as any).mock.calls)
    expect(logged).toContain('POST /api/wholesale/orders')
    expect(logged).not.toMatch(/Maria|84999999999|5584999999999/)
  })

  it('WHOLESALE_CLIENT_IP_HEADER: usa o header controlado pela borda em vez do X-Forwarded-For (que o cliente pode forjar)', async () => {
    process.env.WHOLESALE_CLIENT_IP_HEADER = 'cf-connecting-ip'
    try {
      await POST(req(valid(), { 'x-forwarded-for': '6.6.6.6', 'cf-connecting-ip': '198.51.100.9' }))
      expect(createWholesaleOrder).toHaveBeenCalledWith(expect.objectContaining({ clientIp: '198.51.100.9' }))
    } finally { delete process.env.WHOLESALE_CLIENT_IP_HEADER }
  })
})
