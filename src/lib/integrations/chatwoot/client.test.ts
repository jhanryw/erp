import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  validateChatwootBaseUrl,
  isPermanentChatwootError,
  getChatwootContact,
  updateChatwootContactCustomAttributes,
  createChatwootCustomAttributeDefinition,
  searchChatwootContacts,
  createChatwootContact,
  getContactableInboxes,
  createContactInbox,
  listContactConversations,
  createChatwootConversation,
  createChatwootMessage,
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

describe('isPermanentChatwootError — classificação retry vs permanente (seção 33 da Fase 4 / seção 12 da Fase 5)', () => {
  it('400/401/403/404/422 são permanentes', () => {
    for (const status of [400, 401, 403, 404, 422]) {
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

// ─── Fase N2B — contact search/create, contact_inboxes, conversations, message ──

describe('searchChatwootContacts', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('devolve o array de payload, vazio quando não há match', async () => {
    mockFetchOnce({ jsonBody: { payload: [] }, headers: { 'Content-Type': 'application/json' } })
    const result = await searchChatwootContacts(config, '84999999999')
    expect(result).toEqual({ ok: true, data: [] })
  })

  it('devolve os contatos encontrados', async () => {
    mockFetchOnce({
      jsonBody: { payload: [{ id: 2, name: 'Fulana', phone_number: '+5584999999999', contact_inboxes: [] }] },
      headers: { 'Content-Type': 'application/json' },
    })
    const result = await searchChatwootContacts(config, '84999999999')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toHaveLength(1)
  })

  it('escapa a query na URL', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => ({ payload: [] }), text: async () => '' } as Response)
    vi.stubGlobal('fetch', fetchSpy)
    await searchChatwootContacts(config, '+55 84 99999-9999')
    const calledUrl = fetchSpy.mock.calls[0][0] as string
    expect(calledUrl).toContain('/contacts/search?q=')
    expect(calledUrl).not.toContain(' ')
  })
})

describe('createChatwootContact', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('extrai contact + sourceId de payload.contact/payload.contact_inbox', async () => {
    mockFetchOnce({
      jsonBody: {
        payload: {
          contact: { id: 2, name: 'Fulana', phone_number: '+5584999999999', contact_inboxes: [] },
          contact_inbox: { source_id: 'src-abc', inbox: { id: 7 } },
        },
      },
      headers: { 'Content-Type': 'application/json' },
    })
    const result = await createChatwootContact(config, { inboxId: 7, phoneNumber: '+5584999999999', name: 'Fulana' })
    expect(result).toEqual({ ok: true, data: { contact: { id: 2, name: 'Fulana', phone_number: '+5584999999999', contact_inboxes: [] }, sourceId: 'src-abc' } })
  })

  it('resposta sem contact_inbox.source_id → erro (nunca finge sucesso)', async () => {
    mockFetchOnce({ jsonBody: { payload: { contact: { id: 2 } } }, headers: { 'Content-Type': 'application/json' } })
    const result = await createChatwootContact(config, { inboxId: 7, phoneNumber: '+5584999999999' })
    expect(result.ok).toBe(false)
  })

  it('envia inbox_id/phone_number/name no body', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({ payload: { contact: { id: 1 }, contact_inbox: { source_id: 's' } } }),
      text: async () => '',
    } as Response)
    vi.stubGlobal('fetch', fetchSpy)
    await createChatwootContact(config, { inboxId: 7, phoneNumber: '+5584999999999', name: 'Fulana' })
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body).toEqual({ inbox_id: 7, name: 'Fulana', phone_number: '+5584999999999' })
  })
})

describe('getContactableInboxes / createContactInbox', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('getContactableInboxes devolve o payload', async () => {
    mockFetchOnce({ jsonBody: { payload: [{ source_id: 'src-1', inbox: { id: 7 } }] }, headers: { 'Content-Type': 'application/json' } })
    const result = await getContactableInboxes(config, '2')
    expect(result).toEqual({ ok: true, data: [{ source_id: 'src-1', inbox: { id: 7 } }] })
  })

  it('createContactInbox envia inbox_id e devolve source_id', async () => {
    mockFetchOnce({ jsonBody: { source_id: 'src-novo' }, headers: { 'Content-Type': 'application/json' } })
    const result = await createContactInbox(config, '2', 7)
    expect(result).toEqual({ ok: true, data: { source_id: 'src-novo' } })
  })
})

describe('listContactConversations / createChatwootConversation', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('listContactConversations devolve o payload', async () => {
    mockFetchOnce({ jsonBody: { payload: [{ id: 10, status: 'open', inbox_id: 7 }] }, headers: { 'Content-Type': 'application/json' } })
    const result = await listContactConversations(config, '2')
    expect(result).toEqual({ ok: true, data: [{ id: 10, status: 'open', inbox_id: 7 }] })
  })

  it('createChatwootConversation envia source_id/inbox_id/contact_id', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({ id: 11, inbox_id: 7 }),
      text: async () => '',
    } as Response)
    vi.stubGlobal('fetch', fetchSpy)
    const result = await createChatwootConversation(config, { sourceId: 'src-1', inboxId: 7, contactId: '2' })
    expect(result).toEqual({ ok: true, data: { id: 11, inbox_id: 7 } })
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body).toEqual({ source_id: 'src-1', inbox_id: 7, contact_id: '2' })
  })
})

describe('createChatwootMessage', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('sempre envia message_type=outgoing e private=false', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({ id: 99, content: 'oi' }),
      text: async () => '',
    } as Response)
    vi.stubGlobal('fetch', fetchSpy)
    const result = await createChatwootMessage(config, 11, 'oi')
    expect(result).toEqual({ ok: true, data: { id: 99, content: 'oi' } })
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body).toEqual({ content: 'oi', message_type: 'outgoing', private: false })
  })

  it('propaga erro 422 (ex.: conteúdo vazio rejeitado pelo Chatwoot)', async () => {
    mockFetchOnce({ ok: false, status: 422, textBody: 'content is missing' })
    const result = await createChatwootMessage(config, 11, '')
    expect(!result.ok && result.error.status).toBe(422)
  })
})
