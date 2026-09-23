import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { getValidAccessToken } from './tokens'
import { refreshTokens } from './oauth'
import { mercadoLivreRequest } from './client'
import { setMercadoLivreLogSink } from './log'
import { FakeMlApi, FakeMlDb, TEST_CONFIG, setTestCipherEnv } from './fakeMercadoLivre.testutil'

beforeAll(() => setTestCipherEnv())

const COMPANY = 10
const OTHER = 20
let db: FakeMlDb
let api: FakeMlApi
let logs: string[]

const fastSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)))

function seed(expiresInMs: number): { id: number; access: string; refresh: string } {
  const pair = api.issue()
  const id = db.seedConnected(COMPANY, '555', { access: pair.access_token, refresh: pair.refresh_token, expiresAt: new Date(Date.now() + expiresInMs) })
  return { id, access: pair.access_token, refresh: pair.refresh_token }
}

function tokenInput(id: number, workerId: string, extra: Record<string, unknown> = {}) {
  return {
    integrationId: id, companyId: COMPANY, store: db.store(), workerId, sleep: fastSleep,
    refresh: (rt: string) => refreshTokens({ config: TEST_CONFIG, refreshToken: rt, fetchImpl: api.fetch }),
    ...extra,
  }
}

beforeEach(() => {
  db = new FakeMlDb()
  api = new FakeMlApi()
  logs = []
  setMercadoLivreLogSink((l) => logs.push(l))
})
afterEach(() => setMercadoLivreLogSink(null))

describe('getValidAccessToken', () => {
  it('token ainda válido → devolve sem refresh', async () => {
    const s = seed(3 * 3600_000)
    const r = await getValidAccessToken(tokenInput(s.id, 'w1'))
    expect(r).toMatchObject({ accessToken: s.access, refreshed: false })
    expect(api.refreshCalls).toBe(0)
  })

  it('14. token expirado → refresh, grava o par novo cifrado e a nova expiração', async () => {
    const s = seed(-1000)
    const r = await getValidAccessToken(tokenInput(s.id, 'w1'))
    expect(r.refreshed).toBe(true)
    expect(api.refreshCalls).toBe(1)
    expect(db.plainSecret(s.id, 'access_token')).toBe(r.accessToken)
    expect(db.plainSecret(s.id, 'refresh_token')).not.toBe(s.refresh)
    expect(new Date(db.row(s.id)!.credential_expires_at!).getTime()).toBeGreaterThan(Date.now() + 5 * 3600_000)
    expect(db.row(s.id)!.lock_by).toBeNull()
  })

  it('15-17. dois refreshes simultâneos → 1 chamada ao ML; o segundo worker reutiliza o token NOVO', async () => {
    const s = seed(-1000)
    api.tokenDelayMs = 40 // janela para o segundo worker chegar durante o refresh
    const [a, b] = await Promise.all([
      getValidAccessToken(tokenInput(s.id, 'worker-A')),
      getValidAccessToken(tokenInput(s.id, 'worker-B')),
    ])
    expect(api.refreshCalls).toBe(1)
    expect(a.accessToken).toBe(b.accessToken)
    expect(a.accessToken).not.toBe(s.access)
    expect(db.row(s.id)!.status).toBe('active') // ninguém recebeu invalid_grant
    expect(logs.some((l) => l.includes('mercadolivre.token.refresh_waited'))).toBe(true)
  })

  it('5 workers concorrentes → continua 1 refresh, nenhum reuso do refresh token rotacionado', async () => {
    const s = seed(-1000)
    api.tokenDelayMs = 30
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((w) => getValidAccessToken(tokenInput(s.id, w))))
    expect(api.refreshCalls).toBe(1)
    expect(new Set(results.map((r) => r.accessToken)).size).toBe(1)
  })

  it('18. refresh revogado (invalid_grant) → needs_reauth, lease liberado, sem nova tentativa', async () => {
    const s = seed(-1000)
    api.validRefresh.delete(s.refresh) // revogado no ML
    await expect(getValidAccessToken(tokenInput(s.id, 'w1'))).rejects.toMatchObject({ kind: 'reauth_required' })
    expect(db.row(s.id)!.status).toBe('needs_reauth')
    expect(db.row(s.id)!.lock_by).toBeNull()
    await expect(getValidAccessToken(tokenInput(s.id, 'w2'))).rejects.toMatchObject({ kind: 'reauth_required' })
    expect(api.refreshCalls).toBe(1)
  })

  it('falha transitória no refresh (5xx) → status continua ativo, erro retryable, lease liberado', async () => {
    const s = seed(-1000)
    api.overrides.push({ match: (m, u) => m === 'POST' && u.pathname === '/oauth/token', response: () => new Response('{}', { status: 503 }), once: true })
    await expect(getValidAccessToken(tokenInput(s.id, 'w1'))).rejects.toMatchObject({ kind: 'server', retryable: true })
    expect(db.row(s.id)!.status).toBe('active')
    expect(db.row(s.id)!.lock_by).toBeNull()
    // próxima tentativa funciona com o MESMO refresh token (não foi consumido)
    const r = await getValidAccessToken(tokenInput(s.id, 'w2'))
    expect(r.refreshed).toBe(true)
  })

  it('integração desconectada → integration_disabled; outra empresa → not_found (isolamento)', async () => {
    const s = seed(3600_000)
    await expect(getValidAccessToken({ ...tokenInput(s.id, 'w'), companyId: OTHER })).rejects.toMatchObject({ kind: 'integration_not_found' })
    await db.repo().disconnect(s.id, COMPANY, 'u')
    await expect(getValidAccessToken(tokenInput(s.id, 'w'))).rejects.toMatchObject({ kind: 'integration_disabled' })
  })

  it('segundo worker desiste com erro retryable se o dono do lease não termina a tempo', async () => {
    const s = seed(-1000)
    await db.store().claim(s.id, COMPANY, 'dono-travado', 60)
    await expect(getValidAccessToken(tokenInput(s.id, 'w2', { waitMs: 30 }))).rejects.toMatchObject({ kind: 'refresh_in_progress', retryable: true })
    expect(api.refreshCalls).toBe(0)
  })

  it('lease vencido (worker morreu) pode ser retomado por outro', async () => {
    const s = seed(-1000)
    const store = db.store()
    await store.claim(s.id, COMPANY, 'morto', 60)
    db.row(s.id)!.lock_until = Date.now() - 1
    const r = await getValidAccessToken(tokenInput(s.id, 'vivo'))
    expect(r.refreshed).toBe(true)
  })

  it('fencing: worker que perdeu o lease não sobrescreve os tokens do dono atual', async () => {
    const s = seed(-1000)
    const store = db.store()
    await store.claim(s.id, COMPANY, 'antigo', 60)
    db.row(s.id)!.lock_by = 'novo-dono'
    const ok = await store.complete(s.id, COMPANY, 'antigo', { accessToken: 'APP_USR-x', refreshToken: 'TG-x', expiresAt: new Date(), scopes: [], userId: '555' })
    expect(ok).toBe(false)
    expect(db.plainSecret(s.id, 'access_token')).toBe(s.access)
  })
})

describe('mercadoLivreRequest (client central)', () => {
  const deps = () => ({ config: TEST_CONFIG, store: db.store(), fetchImpl: api.fetch, sleep: fastSleep })

  it('22. GET /users/me autenticado', async () => {
    const s = seed(3600_000)
    const res = await mercadoLivreRequest<{ id: number }>({ integrationId: s.id, companyId: COMPANY, method: 'GET', path: '/users/me', deps: deps() })
    expect(res.data.id).toBe(555)
    const call = api.calls.at(-1)!
    expect(call.headers.authorization).toBe(`Bearer ${s.access}`)
    expect(call.url).not.toContain(s.access)
  })

  it('23. 401 → UMA renovação forçada e UMA nova tentativa', async () => {
    const s = seed(3600_000)
    api.validAccess.delete(s.access) // token invalidado antes da expiração (ex.: senha trocada no ML)
    const res = await mercadoLivreRequest<{ id: number }>({ integrationId: s.id, companyId: COMPANY, method: 'GET', path: '/users/me', deps: deps() })
    expect(res.data.id).toBe(555)
    expect(api.refreshCalls).toBe(1)
  })

  it('23b. 401 persistente → erro unauthorized, sem laço', async () => {
    const s = seed(3600_000)
    api.overrides.push({ match: (m, u) => u.pathname === '/users/me', response: () => new Response('{"message":"no"}', { status: 401 }) })
    await expect(mercadoLivreRequest({ integrationId: s.id, companyId: COMPANY, method: 'GET', path: '/users/me', deps: deps() }))
      .rejects.toMatchObject({ kind: 'unauthorized' })
    expect(api.calls.filter((c) => c.url.endsWith('/users/me'))).toHaveLength(2)
    expect(api.refreshCalls).toBe(1)
  })

  it('24. 429 → rate_limited retryable, sem retry dentro da requisição', async () => {
    const s = seed(3600_000)
    api.overrides.push({ match: (_m, u) => u.pathname === '/users/me', response: () => new Response('{"error":"local_rate_limited"}', { status: 429, headers: { 'retry-after': '3' } }) })
    await expect(mercadoLivreRequest({ integrationId: s.id, companyId: COMPANY, method: 'GET', path: '/users/me', deps: deps() }))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 3, retryable: true })
    expect(api.calls.filter((c) => c.url.endsWith('/users/me'))).toHaveLength(1)
  })

  it('25. 5xx → server retryable; log de erro sem token', async () => {
    const s = seed(3600_000)
    api.overrides.push({ match: (_m, u) => u.pathname === '/users/me', response: () => new Response('{}', { status: 500 }) })
    await expect(mercadoLivreRequest({ integrationId: s.id, companyId: COMPANY, method: 'GET', path: '/users/me', deps: deps() }))
      .rejects.toMatchObject({ kind: 'server', retryable: true })
    const all = logs.join('\n')
    expect(all).toContain('mercadolivre.api.error')
    expect(all).not.toContain(s.access)
    expect(all).not.toContain(s.refresh)
  })

  it('19. integração de outra empresa nunca é usada', async () => {
    const s = seed(3600_000)
    await expect(mercadoLivreRequest({ integrationId: s.id, companyId: OTHER, method: 'GET', path: '/users/me', deps: deps() }))
      .rejects.toMatchObject({ kind: 'integration_not_found' })
    expect(api.calls).toHaveLength(0)
  })
})
