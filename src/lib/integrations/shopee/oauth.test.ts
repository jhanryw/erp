import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { buildAuthorizationUrl, exchangeCodeForTokens, hashOAuthState, refreshTokens } from './oauth'
import { setShopeeLogSink } from './log'
import { FakeShopeeApi, FakeShopeeDb, TEST_CONFIG, TEST_PARTNER_KEY, setTestCipherEnv } from './fakeShopee.testutil'
import { completeShopeeOAuth, disconnectShopee, forceRefreshShopeeToken, getShopeeConnections, startShopeeOAuth } from '@/services/integrations/shopee.service'

beforeAll(() => setTestCipherEnv())

const A = { userId: 'user-a', companyId: 1 }
const B = { userId: 'user-b', companyId: 2 }
let db: FakeShopeeDb
let api: FakeShopeeApi
let logs: string[]

const deps = () => ({ repo: db.repo(), store: db.store(), config: TEST_CONFIG, fetchImpl: api.fetch })

async function start(session = A): Promise<string> {
  const { authorizationUrl } = await startShopeeOAuth(session, deps())
  return new URL(authorizationUrl).searchParams.get('state')!
}

beforeEach(() => {
  db = new FakeShopeeDb()
  api = new FakeShopeeApi()
  logs = []
  setShopeeLogSink((l) => logs.push(l))
})
afterEach(() => setShopeeLogSink(null))

describe('lib oauth', () => {
  it('URL de autorização Brasil com partner_id, auth_type=seller, redirect_uri, response_type=code e state', () => {
    const u = new URL(buildAuthorizationUrl({ config: TEST_CONFIG, state: 'st' }))
    expect(`${u.origin}${u.pathname}`).toBe('https://open.shopee.com.br/auth')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      partner_id: '2001234', auth_type: 'seller', redirect_uri: TEST_CONFIG.redirectUri, response_type: 'code', state: 'st',
    })
    expect(u.toString()).not.toContain(TEST_PARTNER_KEY)
  })

  it('token/get: body com code, partner_id e shop_id numéricos; expire_in vira expiresAt', async () => {
    api.codes.set('CODE1', '555')
    const now = new Date('2026-09-28T12:00:00Z')
    const t = await exchangeCodeForTokens({ config: TEST_CONFIG, code: 'CODE1', shopId: '555', fetchImpl: api.fetch, now: () => now })
    expect(api.lastBody).toEqual({ code: 'CODE1', partner_id: 2001234, shop_id: 555 })
    expect(api.lastUrl!.pathname).toBe('/api/v2/auth/token/get')
    expect(t.expiresAt.getTime()).toBe(now.getTime() + 14400 * 1000)
    expect(t.shopId).toBe('555')
  })

  it('access_token/get: refresh_token é de uso único — reuso vira reauth_required', async () => {
    const pair = api.issue('555')
    const t = await refreshTokens({ config: TEST_CONFIG, refreshToken: pair.refresh_token, shopId: '555', fetchImpl: api.fetch })
    expect(t.refreshToken).not.toBe(pair.refresh_token)
    expect(api.lastBody).toEqual({ refresh_token: pair.refresh_token, partner_id: 2001234, shop_id: 555 })
    await expect(refreshTokens({ config: TEST_CONFIG, refreshToken: pair.refresh_token, shopId: '555', fetchImpl: api.fetch }))
      .rejects.toMatchObject({ kind: 'reauth_required' })
  })

  it('erro de assinatura no refresh NÃO vira reauth (é configuração do app)', async () => {
    api.mode = 'bad_sign'
    await expect(refreshTokens({ config: TEST_CONFIG, refreshToken: 'x', shopId: '555', fetchImpl: api.fetch }))
      .rejects.toMatchObject({ kind: 'forbidden', shopeeError: 'error_sign' })
  })
})

describe('fluxo OAuth (service)', () => {
  it('state válido: conecta a loja, grava tokens cifrados e state só como hash', async () => {
    const state = await start()
    expect(db.states).toHaveLength(1)
    expect(db.states[0].state_hash).toBe(hashOAuthState(state))
    expect(JSON.stringify(db.states)).not.toContain(state)
    expect(db.states[0]).toMatchObject({ company_id: 1, user_id: 'user-a' })

    api.codes.set('C1', '555')
    const r = await completeShopeeOAuth(A, { code: 'C1', shopId: '555', state, error: null }, deps())
    expect(r).toMatchObject({ shopId: '555', reconnected: false })
    const row = db.row(r.integrationId)!
    expect(row).toMatchObject({ company_id: 1, provider: 'shopee', status: 'active', external_account_id: '555' })
    expect(db.plainSecret(r.integrationId, 'access_token')).toMatch(/^acc-555-/)
    expect(JSON.stringify(row.settings)).not.toMatch(/acc-|ref-/)
    expect(db.states[0].consumed_at).not.toBeNull()
  })

  it('state inválido (desconhecido) → invalid_state, sem chamar a Shopee', async () => {
    await expect(completeShopeeOAuth(A, { code: 'C1', shopId: '555', state: 'forjado', error: null }, deps()))
      .rejects.toMatchObject({ kind: 'invalid_state' })
    expect(api.tokenCalls).toBe(0)
  })

  it('state expirado → invalid_state', async () => {
    const state = await start()
    db.now = () => Date.now() + 11 * 60_000
    await expect(completeShopeeOAuth(A, { code: 'C1', shopId: '555', state, error: null }, deps()))
      .rejects.toMatchObject({ kind: 'invalid_state', message: expect.stringContaining('expired') })
    expect(api.tokenCalls).toBe(0)
  })

  it('state reusado (consumed_at já setado) → invalid_state na segunda vez', async () => {
    const state = await start()
    api.codes.set('C1', '555')
    await completeShopeeOAuth(A, { code: 'C1', shopId: '555', state, error: null }, deps())
    api.codes.set('C2', '555')
    await expect(completeShopeeOAuth(A, { code: 'C2', shopId: '555', state, error: null }, deps()))
      .rejects.toMatchObject({ kind: 'invalid_state', message: expect.stringContaining('consumed') })
    expect(api.tokenCalls).toBe(1)
  })

  it('callback sem code → invalid_callback, state NÃO é consumido', async () => {
    const state = await start()
    await expect(completeShopeeOAuth(A, { code: null, shopId: '555', state, error: null }, deps()))
      .rejects.toMatchObject({ kind: 'invalid_callback' })
    expect(db.states[0].consumed_at).toBeNull()
  })

  it('callback sem shop_id (ou malformado) → invalid_callback', async () => {
    const state = await start()
    await expect(completeShopeeOAuth(A, { code: 'C1', shopId: null, state, error: null }, deps())).rejects.toMatchObject({ kind: 'invalid_callback' })
    await expect(completeShopeeOAuth(A, { code: 'C1', shopId: '12a', state, error: null }, deps())).rejects.toMatchObject({ kind: 'invalid_callback' })
    expect(api.tokenCalls).toBe(0)
  })

  it('callback com error → oauth_denied', async () => {
    await expect(completeShopeeOAuth(A, { code: null, shopId: null, state: 'x', error: 'access_denied' }, deps()))
      .rejects.toMatchObject({ kind: 'oauth_denied' })
  })

  it('state emitido para a empresa A não conecta na sessão da empresa B', async () => {
    const state = await start(A)
    api.codes.set('C1', '555')
    await expect(completeShopeeOAuth(B, { code: 'C1', shopId: '555', state, error: null }, deps()))
      .rejects.toMatchObject({ kind: 'invalid_state' })
    expect(db.integrations).toHaveLength(0)
    expect(api.tokenCalls).toBe(0)
  })

  it('loja já conectada em outra empresa → account_conflict', async () => {
    db.seedConnected(B.companyId, '555', { access: 'a', refresh: 'r', expiresAt: new Date(Date.now() + 3600_000) })
    const state = await start(A)
    api.codes.set('C1', '555')
    await expect(completeShopeeOAuth(A, { code: 'C1', shopId: '555', state, error: null }, deps()))
      .rejects.toMatchObject({ kind: 'account_conflict' })
  })

  it('multi-loja: duas lojas na mesma empresa = duas integrações; reconectar a mesma reaproveita a linha', async () => {
    api.codes.set('C1', '555'); api.codes.set('C2', '777'); api.codes.set('C3', '555')
    const r1 = await completeShopeeOAuth(A, { code: 'C1', shopId: '555', state: await start(), error: null }, deps())
    const r2 = await completeShopeeOAuth(A, { code: 'C2', shopId: '777', state: await start(), error: null }, deps())
    expect(r2.integrationId).not.toBe(r1.integrationId)
    await disconnectShopee(A.companyId, r1.integrationId, A.userId, deps())
    const r3 = await completeShopeeOAuth(A, { code: 'C3', shopId: '555', state: await start(), error: null }, deps())
    expect(r3).toMatchObject({ integrationId: r1.integrationId, reconnected: true })
    const view = await getShopeeConnections(A.companyId, deps())
    expect(view.shops.map((s) => [s.shop_id, s.state])).toEqual([['555', 'connected'], ['777', 'connected']])
    expect(JSON.stringify(view)).not.toMatch(/acc-|ref-|partner_key/)
  })
})

describe('multi-tenant (service)', () => {
  it('empresa A não vê, não renova e não desconecta a loja da empresa B', async () => {
    const pair = api.issue('999')
    const idB = db.seedConnected(B.companyId, '999', { access: pair.access_token, refresh: pair.refresh_token, expiresAt: new Date(Date.now() - 1000) })

    expect((await getShopeeConnections(A.companyId, deps())).shops).toEqual([])
    await expect(forceRefreshShopeeToken(A.companyId, idB, deps())).rejects.toMatchObject({ kind: 'integration_not_found' })
    await expect(disconnectShopee(A.companyId, idB, A.userId, deps())).rejects.toMatchObject({ kind: 'integration_not_found' })
    expect(api.refreshCalls).toBe(0)
    expect(db.row(idB)).toMatchObject({ status: 'active', external_account_id: '999' })
    expect(db.plainSecret(idB, 'refresh_token')).toBe(pair.refresh_token)
  })

  it('integração de outro provider (mercadolivre) não é acessível pelas operações Shopee', async () => {
    const idMl = db.seedConnected(A.companyId, '555', { access: 'a', refresh: 'r', expiresAt: new Date() }, 'mercadolivre')
    await expect(disconnectShopee(A.companyId, idMl, A.userId, deps())).rejects.toMatchObject({ kind: 'integration_not_found' })
    expect(db.row(idMl)!.status).toBe('active')
  })

  it('desconectar a própria loja: apaga tokens, preserva a linha e a loja anterior', async () => {
    const id = db.seedConnected(A.companyId, '555', { access: 'a', refresh: 'r', expiresAt: new Date(Date.now() + 3600_000) })
    const view = await disconnectShopee(A.companyId, id, A.userId, deps())
    expect(view).toMatchObject({ state: 'disconnected', shop_id: '555' })
    expect(db.plainSecret(id, 'access_token')).toBeNull()
    expect(db.row(id)).toMatchObject({ status: 'inactive', external_account_id: null })
  })
})
