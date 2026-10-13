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
    // Sem proxy confiável declarado, o X-Forwarded-For (forjável) NÃO é usado: IP desconhecido.
    const res = await POST(req(valid(), { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }))
    expect(res.status).toBe(201)
    expect(createWholesaleOrder).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 7, idempotencyKey: KEY, items: [{ variationId: 10, quantity: 3 }], clientIp: null,
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

  describe('IP confiável para o rate limiting', () => {
    const run = async (headers: Record<string, string>, env: Record<string, string>) => {
      Object.assign(process.env, env)
      try {
        ;(createWholesaleOrder as any).mockClear()
        await POST(req(valid(), headers))
        return (createWholesaleOrder as any).mock.calls[0][0].clientIp
      } finally { for (const k of Object.keys(env)) delete process.env[k] }
    }

    it('sem configuração: X-Forwarded-For e X-Real-IP forjados são IGNORADOS (IP desconhecido)', async () => {
      expect(await run({ 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '7.7.7.7' }, {})).toBeNull()
    })

    it('WHOLESALE_CLIENT_IP_HEADER: usa o cabeçalho da borda, não o X-Forwarded-For', async () => {
      expect(await run({ 'x-forwarded-for': '6.6.6.6', 'cf-connecting-ip': '198.51.100.9' }, { WHOLESALE_CLIENT_IP_HEADER: 'cf-connecting-ip' })).toBe('198.51.100.9')
    })

    it('cabeçalho configurado ausente ou inválido → desconhecido (nunca cai para o X-Forwarded-For)', async () => {
      expect(await run({ 'x-forwarded-for': '6.6.6.6' }, { WHOLESALE_CLIENT_IP_HEADER: 'x-real-ip' })).toBeNull()
      expect(await run({ 'x-real-ip': 'não-é-ip' }, { WHOLESALE_CLIENT_IP_HEADER: 'x-real-ip' })).toBeNull()
    })

    it('WHOLESALE_TRUSTED_PROXY_HOPS=1: vale a entrada acrescentada pelo proxy (à direita); a forjada à esquerda é ignorada', async () => {
      expect(await run({ 'x-forwarded-for': '6.6.6.6, 198.51.100.20' }, { WHOLESALE_TRUSTED_PROXY_HOPS: '1' })).toBe('198.51.100.20')
    })

    it('cadeia mais curta que o nº de proxies configurado → desconhecido', async () => {
      expect(await run({ 'x-forwarded-for': '198.51.100.20' }, { WHOLESALE_TRUSTED_PROXY_HOPS: '2' })).toBeNull()
    })
  })

  describe('fallback de WhatsApp só para rate limiting', () => {
    const lines = [{ variationId: 10, productId: 1, productName: 'Calcinha Rosa', sku: 'S10', attributes: [{ type: 'Tamanho', value: 'P/M' }], quantity: 6, unitPrice: 29.9 }]

    it('429 rate_limited → fallback com mensagem de pedido NÃO registrado (sem código) e sem dados internos', async () => {
      ;(createWholesaleOrder as any).mockResolvedValue({ ok: false, status: 429, error: 'rate_limited', message: 'Muitos pedidos', fallbackLines: lines })
      const res = await POST(req(valid()))
      const json = await res.json()
      expect(res.status).toBe(429)
      expect(json.error).toBe('rate_limited')
      expect(json.fallback.whatsappUrl.startsWith('https://wa.me/5584988887777?text=')).toBe(true)
      expect(json.fallback).toMatchObject({ totalItems: 6, subtotal: 179.4 })
      expect(json.fallback.message).toContain('AGUARDANDO CONFIRMAÇÃO DA LOJA')
      expect(json.fallback.message).toContain('ainda não foi registrado')
      expect(json.fallback.message).toContain('Calcinha Rosa')
      expect(json.fallback.message).toContain('Tamanho: P/M')
      expect(json.fallback.message).toContain('Total do pedido: R$ 179,40')
      expect(json.fallback.message).not.toMatch(/AT-\d+/)       // nenhum código de pedido
      expect(json.order).toBeUndefined()
      expect(json.fallbackLines).toBeUndefined()                 // linhas internas nunca saem
      expect(json.validation).toBeUndefined()
    })

    it.each([
      ['estoque/preço (409)', { ok: false, status: 409, error: 'items_unavailable', message: 'm', validation: { valid: false, items: [], summary: {} } }],
      ['abaixo do mínimo (422)', { ok: false, status: 422, error: 'below_minimum', message: 'm', minimumOrder: 300, currentTotal: 100, missingAmount: 200 }],
      ['contato inválido (422)', { ok: false, status: 422, error: 'invalid_customer', message: 'm' }],
      ['falha ao criar (500)', { ok: false, status: 500, error: 'create_failed', message: 'm' }],
      ['WhatsApp da loja ausente (503)', { ok: false, status: 503, error: 'whatsapp_not_configured', message: 'm' }],
    ])('%s NÃO oferece fallback', async (_name, result) => {
      ;(createWholesaleOrder as any).mockResolvedValue({ ...result, fallbackLines: lines }) // mesmo que vazasse linhas
      const res = await POST(req(valid()))
      const json = await res.json()
      expect(res.status).toBe((result as any).status)
      expect(json.fallback).toBeUndefined()
      expect(json.fallbackLines).toBeUndefined()
    })

    it('rate_limited sem WhatsApp válido da loja → sem fallback (nunca gera wa.me quebrado)', async () => {
      ;(resolveWholesalePublicContext as any).mockResolvedValue({ ok: true, companyId: 7, settings: { whatsappPhone: null } })
      ;(createWholesaleOrder as any).mockResolvedValue({ ok: false, status: 429, error: 'rate_limited', message: 'm', fallbackLines: lines })
      const json = await (await POST(req(valid()))).json()
      expect(json.fallback).toBeUndefined()
    })

    it('sucesso normal segue registrado, com código e sem fallback', async () => {
      ;(createWholesaleOrder as any).mockResolvedValue({ ok: true, replay: false, order: persisted })
      const json = await (await POST(req(valid()))).json()
      expect(json.order.code).toBe('AT-000184')
      expect(json.fallback).toBeUndefined()
    })
  })
})
