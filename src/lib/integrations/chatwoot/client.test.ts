import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  validateChatwootBaseUrl,
  isPermanentChatwootError,
  getChatwootContact,
  updateChatwootContactCustomAttributes,
  createChatwootCustomAttributeDefinition,
  type ChatwootClientConfig,
} from './client'

const config: ChatwootClientConfig = { baseUrl: 'https://chat.example.com', accountId: '123', apiToken: 'test-token', timeoutMs: 50 }

interface MockFetchResponse {
  ok?: boolean
  status?: number
  headers?: HeadersInit
  jsonBody?: unknown
  textBody?: string
}

function mockFetchOnce(response: MockFetchResponse) {
  const headers = new Headers(response.headers)
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      headers,
      json: async () => response.jsonBody,
      text: async () => response.textBody ?? '',
    } as Response),
  )
}

describe('validateChatwootBaseUrl — SSRF guard (seção 43)', () => {
  const originalEnv = process.env.NODE_ENV

  afterEach(() => {
    // @ts-expect-error -- NODE_ENV é readonly no type, mas settable em runtime
    process.env.NODE_ENV = originalEnv
  })

  it('aceita https em produção', () => {
    // @ts-expect-error
    process.env.NODE_ENV = 'production'
    expect(validateChatwootBaseUrl('https://chat.example.com').ok).toBe(true)
  })

  it('rejeita http em produção', () => {
    // @ts-expect-error
    process.env.NODE_ENV = 'production'
    expect(validateChatwootBaseUrl('http://chat.example.com').ok).toBe(false)
  })

  it('aceita http fora de produção', () => {
    // @ts-expect-error
    process.env.NODE_ENV = 'test'
    expect(validateChatwootBaseUrl('http://localhost:3001').ok).toBe(true)
  })

  it('rejeita esquemas perigosos sempre (file:, ftp:, javascript:)', () => {
    // @ts-expect-error
    process.env.NODE_ENV = 'test'
    expect(validateChatwootBaseUrl('file:///etc/passwd').ok).toBe(false)
    expect(validateChatwootBaseUrl('ftp://example.com').ok).toBe(false)
    expect(validateChatwootBaseUrl('javascript:alert(1)').ok).toBe(false)
  })

  it('rejeita string que não é URL', () => {
    expect(validateChatwootBaseUrl('não-é-uma-url').ok).toBe(false)
  })
})

describe('isPermanentChatwootError — classificação retry vs permanente (seção 33)', () => {
  it('401/403/404/422 são permanentes', () => {
    for (const status of [401, 403, 404, 422]) {
      expect(isPermanentChatwootError({ kind: 'http', status, message: '' })).toBe(true)
    }
  })

  it('429/500 nunca são permanentes (retryable)', () => {
    for (const status of [429, 500, 502, 503]) {
      expect(isPermanentChatwootError({ kind: 'http', status, message: '' })).toBe(false)
    }
  })

  it('timeout e network nunca são permanentes', () => {
    expect(isPermanentChatwootError({ kind: 'timeout', message: '' })).toBe(false)
    expect(isPermanentChatwootError({ kind: 'network', message: '' })).toBe(false)
  })
})

describe('cliente HTTP — cenários obrigatórios da seção 46 do pedido', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('200 — sucesso, devolve o JSON', async () => {
    mockFetchOnce({ ok: true, status: 200, jsonBody: { id: 1, name: 'Fulano', email: null, phone_number: null, custom_attributes: {} }, headers: { 'Content-Type': 'application/json' } })
    const result = await getChatwootContact(config, '1')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.id).toBe(1)
  })

  it('401 — não autorizado', async () => {
    mockFetchOnce({ ok: false, status: 401, textBody: 'Unauthorized' })
    const result = await getChatwootContact(config, '1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual(expect.objectContaining({ kind: 'http', status: 401 }))
  })

  it('403 — acesso negado', async () => {
    mockFetchOnce({ ok: false, status: 403, textBody: 'Forbidden' })
    const result = await getChatwootContact(config, '1')
    expect(!result.ok && result.error.status).toBe(403)
  })

  it('404 — contato não encontrado', async () => {
    mockFetchOnce({ ok: false, status: 404, textBody: 'Not Found' })
    const result = await getChatwootContact(config, '999')
    expect(!result.ok && result.error.status).toBe(404)
  })

  it('422 — payload rejeitado', async () => {
    mockFetchOnce({ ok: false, status: 422, textBody: 'Unprocessable' })
    const result = await updateChatwootContactCustomAttributes(config, '1', { qarvon_total_orders: 5 })
    expect(!result.ok && result.error.status).toBe(422)
  })

  it('429 — rate limit, captura Retry-After', async () => {
    mockFetchOnce({ ok: false, status: 429, headers: { 'Retry-After': '30' }, textBody: 'Too Many Requests' })
    const result = await getChatwootContact(config, '1')
    expect(!result.ok && result.error.status).toBe(429)
    expect(!result.ok && result.error.retryAfterSeconds).toBe(30)
  })

  it('500 — erro interno do Chatwoot', async () => {
    mockFetchOnce({ ok: false, status: 500, textBody: 'Internal Server Error' })
    const result = await getChatwootContact(config, '1')
    expect(!result.ok && result.error.status).toBe(500)
  })

  it('timeout — aborta após o limite configurado', async () => {
    // Simula o comportamento real do fetch nativo: nunca resolve por conta
    // própria, mas rejeita com AbortError quando o AbortSignal dispara —
    // é isso que o `AbortController` + `setTimeout` do client.ts aciona.
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    }))
    const result = await getChatwootContact(config, '1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('timeout')
  }, 2000)

  it('falha de rede (fetch rejeita)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const result = await getChatwootContact(config, '1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('network')
  })

  it('base_url inválida é rejeitada antes de qualquer fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const result = await getChatwootContact({ ...config, baseUrl: 'ftp://example.com' }, '1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('invalid_base_url')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('204 sem corpo é tratado como sucesso com data=null', async () => {
    mockFetchOnce({ ok: true, status: 204 })
    const result = await updateChatwootContactCustomAttributes(config, '1', {})
    expect(result).toEqual({ ok: true, data: null })
  })

  it('nunca envia Authorization: Bearer — usa api_access_token', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({}),
      text: async () => '',
    } as Response)
    vi.stubGlobal('fetch', fetchSpy)
    await getChatwootContact(config, '1')
    const callHeaders = fetchSpy.mock.calls[0][1].headers
    expect(callHeaders.api_access_token).toBe('test-token')
    expect(callHeaders.Authorization).toBeUndefined()
  })

  it('URL construída usa account_id da config, nunca hardcoded', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({}),
      text: async () => '',
    } as Response)
    vi.stubGlobal('fetch', fetchSpy)
    await getChatwootContact({ ...config, accountId: '999' }, '42')
    const calledUrl = fetchSpy.mock.calls[0][0] as string
    expect(calledUrl).toContain('/accounts/999/contacts/42')
  })

  it('createChatwootCustomAttributeDefinition sempre envia attribute_model=1 (contact_attribute)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({}),
      text: async () => '',
    } as Response)
    vi.stubGlobal('fetch', fetchSpy)
    await createChatwootCustomAttributeDefinition(config, { attributeKey: 'qarvon_total_orders', attributeDisplayName: 'Total de Pedidos', attributeDisplayType: 1 })
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.attribute_model).toBe(1)
    expect(body.attribute_key).toBe('qarvon_total_orders')
  })
})
