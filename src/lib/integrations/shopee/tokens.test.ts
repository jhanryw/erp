import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { getValidAccessToken } from './tokens'
import { refreshTokens } from './oauth'
import { setShopeeLogSink } from './log'
import { FakeShopeeApi, FakeShopeeDb, TEST_CONFIG, setTestCipherEnv } from './fakeShopee.testutil'

beforeAll(() => setTestCipherEnv())

const COMPANY = 10
const SHOP = '555'
let db: FakeShopeeDb
let api: FakeShopeeApi
let logs: string[]

const fastSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)))

function seed(expiresInMs: number) {
  const pair = api.issue(SHOP)
  const id = db.seedConnected(COMPANY, SHOP, { access: pair.access_token, refresh: pair.refresh_token, expiresAt: new Date(Date.now() + expiresInMs) })
  return { id, access: pair.access_token, refresh: pair.refresh_token }
}

function input(id: number, workerId: string, extra: Record<string, unknown> = {}) {
  return {
    integrationId: id, companyId: COMPANY, store: db.store(), workerId, sleep: fastSleep,
    refresh: (rt: string) => refreshTokens({ config: TEST_CONFIG, refreshToken: rt, shopId: SHOP, fetchImpl: api.fetch }),
    ...extra,
  }
}

beforeEach(() => {
  db = new FakeShopeeDb()
  api = new FakeShopeeApi()
  logs = []
  setShopeeLogSink((l) => logs.push(l))
})
afterEach(() => setShopeeLogSink(null))

describe('getValidAccessToken (Shopee)', () => {
  it('access token ainda válido → não dispara refresh', async () => {
    const s = seed(3 * 3600_000)
    const r = await getValidAccessToken(input(s.id, 'w1'))
    expect(r).toMatchObject({ accessToken: s.access, refreshed: false })
    expect(api.refreshCalls).toBe(0)
  })

  it('access token expirado → refresh; troca access E refresh (refresh_token novo gravado)', async () => {
    const s = seed(-1000)
    const r = await getValidAccessToken(input(s.id, 'w1'))
    expect(r.refreshed).toBe(true)
    expect(api.refreshCalls).toBe(1)
    expect(r.accessToken).not.toBe(s.access)
    expect(db.plainSecret(s.id, 'access_token')).toBe(r.accessToken)
    const newRefresh = db.plainSecret(s.id, 'refresh_token')
    expect(newRefresh).not.toBe(s.refresh)
    expect(api.liveRefresh.has(newRefresh!)).toBe(true)
    expect(new Date(db.row(s.id)!.credential_expires_at!).getTime()).toBeGreaterThan(Date.now() + 3 * 3600_000)
    expect(db.row(s.id)!.lock_by).toBeNull()
  })

  it('perto de expirar (dentro da margem de 5 min) também renova', async () => {
    const s = seed(2 * 60_000)
    expect((await getValidAccessToken(input(s.id, 'w1'))).refreshed).toBe(true)
  })

  it('duas chamadas concorrentes → só uma consome o refresh_token; a outra reutiliza o token NOVO', async () => {
    const s = seed(-1000)
    api.delayMs = 30
    const [a, b] = await Promise.all([getValidAccessToken(input(s.id, 'w1')), getValidAccessToken(input(s.id, 'w2'))])
    expect(api.refreshCalls).toBe(1)
    expect(a.accessToken).toBe(b.accessToken)
    expect([a.refreshed, b.refreshed].sort()).toEqual([false, true])
    expect(db.row(s.id)!.status).toBe('active')
    expect(logs.some((l) => l.includes('shopee.token.refresh_waited'))).toBe(true)
  })

  it('refresh recusado (refresh_token inválido/expirado) → needs_reauth, sem retry', async () => {
    const s = seed(-1000)
    api.liveRefresh.clear() // Shopee não reconhece mais o refresh_token
    await expect(getValidAccessToken(input(s.id, 'w1'))).rejects.toMatchObject({ kind: 'reauth_required' })
    expect(api.refreshCalls).toBe(1)
    expect(db.row(s.id)).toMatchObject({ status: 'needs_reauth', lock_by: null })
    // chamada seguinte falha direto, sem nova chamada à Shopee
    await expect(getValidAccessToken(input(s.id, 'w2'))).rejects.toMatchObject({ kind: 'reauth_required' })
    expect(api.refreshCalls).toBe(1)
  })

  it('erro transitório (5xx) NÃO derruba o token: status mantido, refresh_token preservado, erro retryable', async () => {
    const s = seed(-1000)
    api.mode = 'server_error'
    await expect(getValidAccessToken(input(s.id, 'w1'))).rejects.toSatisfy((e: { kind: string; retryable: boolean }) => e.kind === 'server' && e.retryable)
    expect(db.row(s.id)).toMatchObject({ status: 'active', lock_by: null })
    expect(db.plainSecret(s.id, 'refresh_token')).toBe(s.refresh)
    api.mode = 'ok'
    expect((await getValidAccessToken(input(s.id, 'w2'))).refreshed).toBe(true)
  })

  it('timeout NÃO marca needs_reauth', async () => {
    const s = seed(-1000)
    api.mode = 'timeout'
    await expect(getValidAccessToken(input(s.id, 'w1'))).rejects.toMatchObject({ kind: 'timeout' })
    expect(db.row(s.id)).toMatchObject({ status: 'active', lock_by: null })
    expect(db.plainSecret(s.id, 'refresh_token')).toBe(s.refresh)
  })

  it('empresa errada → integration_not_found (store filtra por company_id)', async () => {
    const s = seed(-1000)
    await expect(getValidAccessToken({ ...input(s.id, 'w1'), companyId: 99 })).rejects.toMatchObject({ kind: 'integration_not_found' })
    expect(api.refreshCalls).toBe(0)
  })

  it('nenhum token aparece nos logs', async () => {
    const s = seed(-1000)
    const r = await getValidAccessToken(input(s.id, 'w1'))
    const all = logs.join('\n')
    expect(all).not.toContain(r.accessToken)
    expect(all).not.toContain(s.refresh)
  })
})
