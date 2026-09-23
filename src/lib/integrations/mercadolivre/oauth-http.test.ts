import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generateOAuthState,
  generatePkcePair,
  hashOAuthState,
  parseTokenResponse,
  refreshTokens,
} from './oauth'
import { getMercadoLivreConfig } from './config'
import { mlHttp } from './http'
import { MercadoLivreError, redactSecrets } from './errors'
import { buildLogLine, logMercadoLivre, setMercadoLivreLogSink } from './log'
import { FakeMlApi, TEST_CONFIG } from './fakeMercadoLivre.testutil'

afterEach(() => setMercadoLivreLogSink(null))

describe('1. URL de autorização', () => {
  it('monta a URL oficial do Brasil com client_id, redirect fixa, state e PKCE S256', () => {
    const pkce = generatePkcePair()
    const url = new URL(buildAuthorizationUrl({ config: TEST_CONFIG, state: 'abc', codeChallenge: pkce.challenge }))
    expect(url.origin + url.pathname).toBe('https://auth.mercadolivre.com.br/authorization')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('APPID123')
    expect(url.searchParams.get('redirect_uri')).toBe(TEST_CONFIG.redirectUri)
    expect(url.searchParams.get('state')).toBe('abc')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.toString()).not.toContain(TEST_CONFIG.clientSecret)
  })

  it('PKCE: challenge = base64url(sha256(verifier))', () => {
    const { verifier, challenge } = generatePkcePair()
    const expected = createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(challenge).toBe(expected)
    expect(verifier.length).toBeGreaterThanOrEqual(43)
  })

  it('outros sites usam o domínio do país; site desconhecido é erro de config', () => {
    expect(buildAuthorizationUrl({ config: TEST_CONFIG, state: 's', codeChallenge: 'c', siteId: 'MLA' })).toContain('auth.mercadolibre.com.ar')
    expect(() => buildAuthorizationUrl({ config: TEST_CONFIG, state: 's', codeChallenge: 'c', siteId: 'XXX' })).toThrow(MercadoLivreError)
  })

  it('state é aleatório e só o hash é persistível', () => {
    const a = generateOAuthState()
    const b = generateOAuthState()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(43)
    expect(hashOAuthState(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashOAuthState(a)).not.toContain(a)
  })
})

describe('config', () => {
  it('sem credenciais → erro de configuração tipado (sem inventar valores)', () => {
    expect(() => getMercadoLivreConfig({} as NodeJS.ProcessEnv)).toThrow(/MERCADOLIVRE_CLIENT_ID/)
  })
  it('redirect com query string é recusada (precisa ser fixa)', () => {
    expect(() => getMercadoLivreConfig({
      MERCADOLIVRE_CLIENT_ID: 'x', MERCADOLIVRE_CLIENT_SECRET: 'y', MERCADOLIVRE_REDIRECT_URI: 'https://a.com/cb?company=1',
    } as unknown as NodeJS.ProcessEnv)).toThrow(/query string/)
  })
})

describe('7. troca code → token', () => {
  it('POST /oauth/token com parâmetros no CORPO form-urlencoded (nunca na query) e code_verifier', async () => {
    const api = new FakeMlApi()
    const tokens = await exchangeCodeForTokens({ config: TEST_CONFIG, code: 'TG-good-code', codeVerifier: 'v'.repeat(64), fetchImpl: api.fetch })
    const call = api.calls[0]
    expect(call.method).toBe('POST')
    expect(new URL(call.url).search).toBe('')
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(call.body)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('redirect_uri')).toBe(TEST_CONFIG.redirectUri)
    expect(form.get('code_verifier')).toBe('v'.repeat(64))
    expect(tokens.accessToken).toMatch(/^APP_USR-/)
    expect(tokens.scopes).toEqual(['offline_access', 'read', 'write'])
    expect(tokens.userId).toBe('555')
  })

  it('expires_in vira expiresAt absoluto', () => {
    const now = new Date('2026-09-24T10:00:00Z')
    const t = parseTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 21600, user_id: 1 }, now)
    expect(t.expiresAt.toISOString()).toBe('2026-09-24T16:00:00.000Z')
  })

  it('code inválido → reauth_required (invalid_grant), sem ecoar o code', async () => {
    const api = new FakeMlApi()
    await expect(exchangeCodeForTokens({ config: TEST_CONFIG, code: 'TG-bad-9999', codeVerifier: 'v'.repeat(64), fetchImpl: api.fetch }))
      .rejects.toMatchObject({ kind: 'reauth_required', mlError: 'invalid_grant' })
  })
})

describe('refresh', () => {
  it('refresh_token é de uso único: segundo uso → invalid_grant → reauth_required', async () => {
    const api = new FakeMlApi()
    const first = api.issue()
    const t = await refreshTokens({ config: TEST_CONFIG, refreshToken: first.refresh_token, fetchImpl: api.fetch })
    expect(t.refreshToken).not.toBe(first.refresh_token)
    await expect(refreshTokens({ config: TEST_CONFIG, refreshToken: first.refresh_token, fetchImpl: api.fetch }))
      .rejects.toMatchObject({ kind: 'reauth_required' })
  })
})

describe('23-25. erros HTTP tipados', () => {
  const call = (status: number, headers: Record<string, string> = {}, body: unknown = { message: 'x' }) =>
    mlHttp({ baseUrl: 'https://api.mercadolibre.com', method: 'GET', path: '/users/me', accessToken: 'APP_USR-secret-123',
      fetchImpl: async () => new Response(JSON.stringify(body), { status, headers }) })

  it('401 → unauthorized', async () => {
    await expect(call(401)).rejects.toMatchObject({ kind: 'unauthorized', httpStatus: 401, retryable: false })
  })
  it('429 → rate_limited, retryable, respeita Retry-After', async () => {
    await expect(call(429, { 'retry-after': '12' }, { error: 'local_rate_limited' })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 12, retryable: true })
  })
  it('5xx → server, retryable', async () => {
    await expect(call(503)).rejects.toMatchObject({ kind: 'server', retryable: true })
  })
  it('timeout → timeout, retryable', async () => {
    const hang = (_: string, init?: RequestInit) => new Promise<Response>((_r, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
    await expect(mlHttp({ baseUrl: 'https://api.mercadolibre.com', method: 'GET', path: '/x', timeoutMs: 20, fetchImpl: hang }))
      .rejects.toMatchObject({ kind: 'timeout', retryable: true })
  })
  it('token vai no header Authorization, nunca na URL', async () => {
    let seen: { url: string; auth: string | undefined } | null = null
    await mlHttp({ baseUrl: 'https://api.mercadolibre.com', method: 'GET', path: '/users/me', accessToken: 'APP_USR-secret-123',
      fetchImpl: async (url, init) => { seen = { url, auth: (init?.headers as Record<string, string>).authorization }; return new Response('{}') } })
    expect(seen!.url).not.toContain('APP_USR')
    expect(seen!.auth).toBe('Bearer APP_USR-secret-123')
  })
  it('mensagem de erro que ecoa credencial é redigida', async () => {
    await expect(call(400, {}, { error: 'bad', message: 'token APP_USR-123-abc refresh TG-999 invalid' }))
      .rejects.toSatisfy((e: MercadoLivreError) => !e.message.includes('APP_USR-123') && !e.message.includes('TG-999'))
  })
})

describe('26. logs sem segredo', () => {
  it('redactSecrets remove access/refresh/code/client_secret/Bearer', () => {
    const txt = redactSecrets('APP_USR-1-2-3 TG-abc Bearer xyz.123 client_secret=shh code=TG-1 refresh_token: "r1"')
    for (const leaked of ['APP_USR-1-2-3', 'TG-abc', 'xyz.123', 'shh', 'r1']) expect(txt).not.toContain(leaked)
  })

  it('só campos da allowlist entram no log — um token passado por engano é descartado', () => {
    const line = buildLogLine('mercadolivre.oauth.completed', {
      company_id: 1, integration_id: 2, seller_id: '555', reason: 'ok',
      ...({ access_token: 'APP_USR-leak', refresh_token: 'TG-leak', code: 'TG-code' } as object),
    })
    expect(line).not.toContain('APP_USR-leak')
    expect(line).not.toContain('TG-leak')
    expect(line).not.toContain('TG-code')
    expect(JSON.parse(line)).toMatchObject({ event: 'mercadolivre.oauth.completed', company_id: 1, integration_id: 2, seller_id: '555' })
  })

  it('texto livre em campo permitido também é redigido', () => {
    const lines: string[] = []
    setMercadoLivreLogSink((l) => lines.push(l))
    logMercadoLivre('mercadolivre.token.refresh_failed', { reason: 'falhou com APP_USR-999-zzz' })
    expect(lines[0]).not.toContain('APP_USR-999-zzz')
  })
})
