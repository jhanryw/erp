import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import {
  completeMercadoLivreOAuth,
  disconnectMercadoLivre,
  revalidateMercadoLivreConnection,
  forceRefreshMercadoLivreToken,
  startMercadoLivreOAuth,
  toConnectionView,
} from './mercadolivre.service'
import { hashOAuthState } from '@/lib/integrations/mercadolivre/oauth'
import { setMercadoLivreLogSink } from '@/lib/integrations/mercadolivre/log'
import { FakeMlApi, FakeMlDb, TEST_CONFIG, setTestCipherEnv } from '@/lib/integrations/mercadolivre/fakeMercadoLivre.testutil'

beforeAll(() => setTestCipherEnv())

const A = { userId: 'user-a', companyId: 1 }
const A2 = { userId: 'user-a2', companyId: 1 }
const B = { userId: 'user-b', companyId: 2 }

let db: FakeMlDb
let api: FakeMlApi
let logs: string[]
const deps = () => ({ repo: db.repo(), store: db.store(), config: TEST_CONFIG, fetchImpl: api.fetch })

/** Inicia o OAuth e devolve o state em claro (tirado da URL, como o navegador faria). */
async function start(session = A): Promise<string> {
  const { authorizationUrl } = await startMercadoLivreOAuth(session, deps())
  return new URL(authorizationUrl).searchParams.get('state')!
}

async function connect(session = A) {
  const state = await start(session)
  return completeMercadoLivreOAuth(session, { code: 'TG-good-code', state, error: null }, deps())
}

beforeEach(() => {
  db = new FakeMlDb()
  api = new FakeMlApi()
  logs = []
  setMercadoLivreLogSink((l) => logs.push(l))
})
afterEach(() => setMercadoLivreLogSink(null))

describe('start OAuth', () => {
  it('1-2. gera URL e grava state SÓ como hash, vinculado a empresa+usuário+expiração, com verifier PKCE cifrado', async () => {
    const state = await start()
    expect(db.states).toHaveLength(1)
    const row = db.states[0]
    expect(row.state_hash).toBe(hashOAuthState(state))
    expect(JSON.stringify(row)).not.toContain(state)
    expect(row).toMatchObject({ company_id: 1, user_id: 'user-a' })
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now())
    expect(row.code_verifier_ciphertext).toBeTruthy()
    expect(logs.some((l) => l.includes('mercadolivre.oauth.started'))).toBe(true)
  })
})

describe('callback', () => {
  it('7/9/12/13/22. fluxo feliz: troca code, consulta /users/me, cria integração, cifra tokens', async () => {
    const result = await connect()
    expect(result).toMatchObject({ sellerId: '555', reconnected: false })
    const row = db.row(result.integrationId)!
    expect(row).toMatchObject({ company_id: 1, status: 'active', external_account_id: '555' })
    expect(row.settings).toMatchObject({ seller_id: '555', nickname: 'LOJA_TESTE', site_id: 'MLB', country_id: 'BR', is_test_user: true })
    // sem PII desnecessária
    expect(JSON.stringify(row.settings)).not.toContain('nao-persistir@example.com')
    // cifrado no "banco", decifrável internamente
    const stored = db.secrets.filter((s) => s.integration_id === result.integrationId)
    expect(stored.map((s) => s.key).sort()).toEqual(['access_token', 'refresh_token'])
    for (const s of stored) expect(s.ciphertext).not.toMatch(/APP_USR|TG-/)
    expect(db.plainSecret(result.integrationId, 'access_token')).toMatch(/^APP_USR-access-/)
    // code_verifier enviado ao ML
    const tokenCall = api.calls.find((c) => c.url.endsWith('/oauth/token'))!
    expect(new URLSearchParams(tokenCall.body).get('code_verifier')).toBeTruthy()
  })

  it('8. nada de token no retorno ao navegador, na view nem nos logs', async () => {
    const result = await connect()
    const view = toConnectionView(await db.repo().getIntegration(1))
    const access = db.plainSecret(result.integrationId, 'access_token')!
    const refresh = db.plainSecret(result.integrationId, 'refresh_token')!
    for (const blob of [JSON.stringify(result), JSON.stringify(view), logs.join('\n')]) {
      expect(blob).not.toContain(access)
      expect(blob).not.toContain(refresh)
      expect(blob).not.toContain('TG-good-code')
      expect(blob).not.toContain(TEST_CONFIG.clientSecret)
    }
    expect(view).toMatchObject({ state: 'connected', seller_id: '555', nickname: 'LOJA_TESTE', site_id: 'MLB', is_test_user: true })
  })

  it('3. state expirado → invalid_state', async () => {
    const state = await start()
    db.states[0].expires_at = new Date(Date.now() - 1000).toISOString()
    await expect(completeMercadoLivreOAuth(A, { code: 'TG-good-code', state, error: null }, deps())).rejects.toMatchObject({ kind: 'invalid_state' })
    expect(api.calls).toHaveLength(0)
  })

  it('4. state manipulado → invalid_state (nenhuma chamada ao ML)', async () => {
    await start()
    await expect(completeMercadoLivreOAuth(A, { code: 'TG-good-code', state: 'forjado', error: null }, deps())).rejects.toMatchObject({ kind: 'invalid_state' })
    expect(api.calls).toHaveLength(0)
  })

  it('state é de uso único (replay do callback falha)', async () => {
    const state = await start()
    await completeMercadoLivreOAuth(A, { code: 'TG-good-code', state, error: null }, deps())
    await expect(completeMercadoLivreOAuth(A, { code: 'TG-good-code', state, error: null }, deps())).rejects.toMatchObject({ kind: 'invalid_state' })
  })

  it('5. callback sem code → invalid_state', async () => {
    const state = await start()
    await expect(completeMercadoLivreOAuth(A, { code: null, state, error: null }, deps())).rejects.toMatchObject({ kind: 'invalid_state' })
  })

  it('6. callback com error (usuário negou) → oauth_denied, log de falha', async () => {
    const state = await start()
    await expect(completeMercadoLivreOAuth(A, { code: null, state, error: 'access_denied' }, deps())).rejects.toMatchObject({ kind: 'oauth_denied' })
    expect(logs.some((l) => l.includes('mercadolivre.oauth.failed'))).toBe(true)
  })

  it('19. tenant crossover: state emitido para a empresa A não pode ser finalizado pela empresa B', async () => {
    const state = await start(A)
    await expect(completeMercadoLivreOAuth(B, { code: 'TG-good-code', state, error: null }, deps())).rejects.toMatchObject({ kind: 'invalid_state' })
    expect(db.integrations).toHaveLength(0)
  })

  it('state de outro usuário da MESMA empresa também é recusado', async () => {
    const state = await start(A)
    await expect(completeMercadoLivreOAuth(A2, { code: 'TG-good-code', state, error: null }, deps())).rejects.toMatchObject({ kind: 'invalid_state' })
  })

  it('10/21. reconexão atualiza a MESMA integração (sem duplicar)', async () => {
    const first = await connect()
    const second = await connect()
    expect(second).toMatchObject({ integrationId: first.integrationId, reconnected: true })
    expect(db.integrations).toHaveLength(1)
  })

  it('11. mesma conta ML não conecta em duas empresas; tokens da tentativa não são gravados', async () => {
    await connect(A)
    await expect(connect(B)).rejects.toMatchObject({ kind: 'account_conflict' })
    expect(db.integrations.filter((r) => r.company_id === 2)).toHaveLength(0)
    expect(db.secrets.every((s) => s.company_id === 1)).toBe(true)
  })
})

describe('manutenção', () => {
  it('22. revalidar chama /users/me pela integração e atualiza last_validated_at', async () => {
    await connect()
    db.integrations[0].last_validated_at = null
    const view = await revalidateMercadoLivreConnection(1, deps())
    expect(view.last_validated_at).not.toBeNull()
    expect(api.calls.at(-1)!.url).toContain('/users/me')
  })

  it('renovar token forçado troca o par (sem devolver token)', async () => {
    const r = await connect()
    const before = db.plainSecret(r.integrationId, 'access_token')
    const view = await forceRefreshMercadoLivreToken(1, deps())
    expect(db.plainSecret(r.integrationId, 'access_token')).not.toBe(before)
    expect(JSON.stringify(view)).not.toContain('APP_USR')
  })

  it('20. desconectar: revoga no ML, apaga tokens, preserva o registro e libera a conta', async () => {
    const r = await connect()
    const view = await disconnectMercadoLivre(1, 'user-a', deps())
    expect(api.revoked).toBe(true)
    expect(view.state).toBe('disconnected')
    const row = db.row(r.integrationId)!
    expect(row).toMatchObject({ status: 'inactive', external_account_id: null })
    expect(row.settings).toMatchObject({ previous_external_account_id: '555' })
    expect(db.secrets.filter((s) => s.integration_id === r.integrationId)).toHaveLength(0)
    expect(logs.some((l) => l.includes('mercadolivre.integration.disconnected'))).toBe(true)
  })

  it('21. reconectar depois de desconectar reativa o mesmo registro', async () => {
    const r = await connect()
    await disconnectMercadoLivre(1, 'user-a', deps())
    const again = await connect()
    expect(again).toMatchObject({ integrationId: r.integrationId, reconnected: true })
    expect(db.row(r.integrationId)).toMatchObject({ status: 'active', external_account_id: '555' })
  })

  it('após desconectar em A, a conta pode ser conectada em B', async () => {
    await connect(A)
    await disconnectMercadoLivre(1, 'user-a', deps())
    await expect(connect(B)).resolves.toMatchObject({ sellerId: '555' })
  })

  it('desconectar funciona mesmo se a revogação no ML falhar', async () => {
    await connect()
    api.overrides.push({ match: (m) => m === 'DELETE', response: () => new Response('{}', { status: 500 }) })
    const view = await disconnectMercadoLivre(1, 'user-a', deps())
    expect(view.state).toBe('disconnected')
  })

  it('estados distinguem desligado × token inválido × erro transitório', () => {
    const base = { id: 1, company_id: 1, external_account_id: '555', settings: {}, last_error: 'x', credential_expires_at: null, credential_refreshed_at: null, last_validated_at: null, connected_at: null, disconnected_at: null }
    expect(toConnectionView({ ...base, status: 'inactive' }).state).toBe('disconnected')
    expect(toConnectionView({ ...base, status: 'needs_reauth' }).state).toBe('needs_reauth')
    expect(toConnectionView({ ...base, status: 'error' }).state).toBe('error')
    expect(toConnectionView({ ...base, status: 'active' }).state).toBe('connected')
    expect(toConnectionView(null).state).toBe('disconnected')
    expect(toConnectionView(null, false).state).toBe('not_configured')
  })
})
