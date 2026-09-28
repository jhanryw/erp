import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { signPublicRequest, signShopRequest, shopeeTimestamp } from './sign'
import { ShopeeError } from './errors'
import { shopeeHttp } from './http'
import { setShopeeLogSink, logShopee } from './log'
import { TEST_CONFIG, TEST_PARTNER_KEY } from './fakeShopee.testutil'

const base = { partnerId: 2001234, partnerKey: TEST_PARTNER_KEY, path: '/api/v2/auth/token/get', timestamp: 1_700_000_000 }
const shop = { ...base, path: '/api/v2/product/get_item_list', accessToken: 'acc-token-xyz', shopId: 123456 }

afterEach(() => setShopeeLogSink(null))

describe('assinatura Public API', () => {
  it('é determinística e igual ao HMAC-SHA256 hex de partner_id+path+timestamp', () => {
    const a = signPublicRequest(base)
    expect(a).toBe(signPublicRequest({ ...base }))
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(createHmac('sha256', TEST_PARTNER_KEY).update('2001234/api/v2/auth/token/get1700000000').digest('hex'))
  })

  it('mudar path muda a assinatura', () => {
    expect(signPublicRequest({ ...base, path: '/api/v2/auth/access_token/get' })).not.toBe(signPublicRequest(base))
  })

  it('mudar timestamp muda a assinatura', () => {
    expect(signPublicRequest({ ...base, timestamp: base.timestamp + 1 })).not.toBe(signPublicRequest(base))
  })

  it('mudar partner_key muda a assinatura', () => {
    expect(signPublicRequest({ ...base, partnerKey: 'outra' })).not.toBe(signPublicRequest(base))
  })
})

describe('assinatura Shop API', () => {
  it('base = partner_id+path+timestamp+access_token+shop_id', () => {
    expect(signShopRequest(shop)).toBe(
      createHmac('sha256', TEST_PARTNER_KEY).update('2001234/api/v2/product/get_item_list1700000000acc-token-xyz123456').digest('hex'),
    )
    expect(signShopRequest(shop)).toBe(signShopRequest({ ...shop, shopId: '123456' }))
  })

  it('mudar shop_id muda a assinatura', () => {
    expect(signShopRequest({ ...shop, shopId: 123457 })).not.toBe(signShopRequest(shop))
  })

  it('mudar access_token, path ou timestamp muda a assinatura', () => {
    const ref = signShopRequest(shop)
    expect(signShopRequest({ ...shop, accessToken: 'outro' })).not.toBe(ref)
    expect(signShopRequest({ ...shop, path: '/api/v2/shop/get_shop_info' })).not.toBe(ref)
    expect(signShopRequest({ ...shop, timestamp: shop.timestamp + 60 })).not.toBe(ref)
  })

  it('Shop API difere da Public API para o mesmo path/timestamp', () => {
    expect(signShopRequest(shop)).not.toBe(signPublicRequest({ ...base, path: shop.path }))
  })
})

describe('partner_key nunca vaza', () => {
  it('erros de validação da assinatura não contêm a chave nem o token', () => {
    const cases: Array<() => unknown> = [
      () => signPublicRequest({ ...base, path: 'sem-barra' }),
      () => signPublicRequest({ ...base, timestamp: 1.5 }),
      () => signPublicRequest({ ...base, partnerId: 0 }),
      () => signShopRequest({ ...shop, shopId: 'abc' }),
      () => signShopRequest({ ...shop, accessToken: '' }),
    ]
    for (const run of cases) {
      let caught: unknown
      try { run() } catch (e) { caught = e }
      expect(caught).toBeInstanceOf(ShopeeError)
      const text = `${(caught as Error).message} ${JSON.stringify(caught)} ${String((caught as Error).stack)}`
      expect(text).not.toContain(TEST_PARTNER_KEY)
      expect(text).not.toContain('acc-token-xyz')
    }
  })

  it('erro HTTP do client não contém chave, sign, access_token nem a query string', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: 'error_auth', message: `bad access_token=acc-token-xyz partner_key=${TEST_PARTNER_KEY}` }), { status: 403 })
    let caught: ShopeeError | undefined
    try {
      await shopeeHttp({ config: TEST_CONFIG, method: 'GET', path: '/api/v2/shop/get_shop_info', auth: { kind: 'shop', accessToken: 'acc-token-xyz', shopId: 1 }, fetchImpl })
    } catch (e) { caught = e as ShopeeError }
    expect(caught?.kind).toBe('forbidden')
    expect(caught!.message).not.toContain(TEST_PARTNER_KEY)
    expect(caught!.message).not.toContain('acc-token-xyz')
    expect(caught!.message).not.toContain('sign=')
    expect(caught!.message).toContain('/api/v2/shop/get_shop_info')
  })

  it('erro de rede/timeout só cita o path', async () => {
    const fetchImpl = async () => { const e = new Error(`boom ${TEST_PARTNER_KEY}`); e.name = 'AbortError'; throw e }
    await expect(shopeeHttp({ config: TEST_CONFIG, method: 'POST', path: '/api/v2/auth/token/get', auth: { kind: 'public' }, body: {}, fetchImpl }))
      .rejects.toSatisfy((e: ShopeeError) => e.kind === 'timeout' && e.retryable && !e.message.includes(TEST_PARTNER_KEY))
  })

  it('log redige chaves sensíveis em campos livres', () => {
    const lines: string[] = []
    setShopeeLogSink((l) => lines.push(l))
    logShopee('shopee.api.error', { reason: `partner_key=${TEST_PARTNER_KEY} access_token=abc`, ...({ partner_key: TEST_PARTNER_KEY } as object) })
    expect(lines[0]).not.toContain(TEST_PARTNER_KEY)
    expect(lines[0]).not.toContain('access_token=abc')
  })
})

describe('client HTTP', () => {
  it('Public API: query com partner_id, timestamp e sign corretos; sem access_token/shop_id', async () => {
    let seen: URL | null = null
    const fetchImpl = async (u: string) => { seen = new URL(u); return new Response(JSON.stringify({ ok: 1, error: '' }), { status: 200 }) }
    const now = () => new Date(1_700_000_000_000)
    await shopeeHttp({ config: TEST_CONFIG, method: 'POST', path: '/api/v2/auth/token/get', auth: { kind: 'public' }, body: {}, fetchImpl, now })
    const u = seen as unknown as URL
    expect(u.origin).toBe('https://openplatform.shopee.com.br')
    expect(u.searchParams.get('partner_id')).toBe('2001234')
    expect(u.searchParams.get('timestamp')).toBe(String(shopeeTimestamp(now())))
    expect(u.searchParams.get('sign')).toBe(signPublicRequest({ ...base, timestamp: 1_700_000_000 }))
    expect(u.searchParams.has('access_token')).toBe(false)
    expect(u.searchParams.has('shop_id')).toBe(false)
  })

  it('HTTP 200 com `error` preenchido é erro; 5xx é server/retryable; JSON inválido é invalid_response', async () => {
    const call = (res: Response) => shopeeHttp({ config: TEST_CONFIG, method: 'GET', path: '/api/v2/x', auth: { kind: 'public' }, fetchImpl: async () => res })
    await expect(call(new Response(JSON.stringify({ error: 'error_param', message: 'x' }), { status: 200 }))).rejects.toMatchObject({ kind: 'bad_request' })
    await expect(call(new Response('{}', { status: 502 }))).rejects.toMatchObject({ kind: 'server' })
    await expect(call(new Response('<html>', { status: 200 }))).rejects.toMatchObject({ kind: 'invalid_response' })
    await expect(call(new Response(JSON.stringify({ error: 'error_auth' }), { status: 401 }))).rejects.toMatchObject({ kind: 'unauthorized' })
    await expect(call(new Response('{}', { status: 429, headers: { 'retry-after': '9' } }))).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 9 })
  })
})
