/**
 * Doubles de teste (NÃO usados em produção) com a MESMA semântica das RPCs
 * da migration 202609241000:
 *   - FakeMlDb: company_integrations + integration_secrets + oauth_states
 *   - repo (MercadoLivreRepo) e store (TokenStore) sobre o mesmo FakeMlDb
 *   - lease atômico (cada chamada JS síncrona entre awaits é indivisível,
 *     como um UPDATE ... WHERE lease livre no Postgres)
 *   - fakeMlApi: servidor do Mercado Livre simulado, com refresh_token de
 *     USO ÚNICO (reusar = invalid_grant), igual à API real.
 * A semântica real das RPCs é coberta em supabase/tests/mercadolivre_oauth.test.sql.
 */

import { decryptSecret, encryptSecret } from '@/lib/security/secretCipher'
import type { ConsumeStateResult, IntegrationRow, MercadoLivreRepo } from '@/services/integrations/mercadolivre.service'
import type { IntegrationTokenState, TokenStore } from './tokens'
import type { MercadoLivreTokens } from './types'

export function setTestCipherEnv(): void {
  process.env.INTEGRATION_SECRETS_CURRENT_KEY_VERSION = '1'
  process.env.INTEGRATION_SECRETS_MASTER_KEY_V1 = Buffer.alloc(32, 7).toString('base64')
}

export const TEST_CONFIG = {
  clientId: 'APPID123',
  clientSecret: 'app-secret-xyz',
  redirectUri: 'https://erp.example.com/api/integrations/mercadolivre/callback',
  usePkce: true,
  defaultSiteId: 'MLB',
  apiBaseUrl: 'https://api.mercadolibre.com',
}

interface Row extends IntegrationRow {
  provider: string
  oauth_scopes: string[] | null
  lock_until: number | null
  lock_by: string | null
}

export class FakeMlDb {
  integrations: Row[] = []
  secrets: Array<{ integration_id: number; company_id: number; key: string; ciphertext: string; key_version: number }> = []
  states: Array<{ state_hash: string; company_id: number; user_id: string; code_verifier_ciphertext: string | null; code_verifier_key_version: number | null; expires_at: string; consumed_at: string | null }> = []
  nextId = 1
  now: () => number = () => Date.now()

  private putSecrets(integrationId: number, companyId: number, access: string, refresh: string, keyVersion: number) {
    this.secrets = this.secrets.filter((s) => !(s.integration_id === integrationId && (s.key === 'access_token' || s.key === 'refresh_token')))
    this.secrets.push({ integration_id: integrationId, company_id: companyId, key: 'access_token', ciphertext: access, key_version: keyVersion })
    this.secrets.push({ integration_id: integrationId, company_id: companyId, key: 'refresh_token', ciphertext: refresh, key_version: keyVersion })
  }

  /** Semeia uma integração conectada (tokens cifrados de verdade). */
  seedConnected(companyId: number, sellerId: string, tokens: { access: string; refresh: string; expiresAt: Date }): number {
    const id = this.nextId++
    this.integrations.push({
      id, company_id: companyId, provider: 'mercadolivre', status: 'active', external_account_id: sellerId,
      settings: { seller_id: sellerId, nickname: `NICK${sellerId}`, site_id: 'MLB' }, last_error: null,
      credential_expires_at: tokens.expiresAt.toISOString(), credential_refreshed_at: null, last_validated_at: null,
      connected_at: new Date().toISOString(), disconnected_at: null, oauth_scopes: ['read'], lock_until: null, lock_by: null,
    })
    const a = encryptSecret(tokens.access)
    const r = encryptSecret(tokens.refresh)
    this.putSecrets(id, companyId, a.ciphertext, r.ciphertext, a.keyVersion)
    return id
  }

  row(id: number): Row | undefined {
    return this.integrations.find((r) => r.id === id)
  }

  plainSecret(integrationId: number, key: string): string | null {
    const s = this.secrets.find((x) => x.integration_id === integrationId && x.key === key)
    return s ? decryptSecret(s.ciphertext, s.key_version) : null
  }

  repo(): MercadoLivreRepo {
    return {
      insertOAuthState: async (row) => { this.states.push({ ...row, consumed_at: null }) },
      consumeOAuthState: async (hash): Promise<ConsumeStateResult> => {
        const st = this.states.find((s) => s.state_hash === hash)
        if (!st) return { status: 'not_found' }
        if (st.consumed_at) return { status: 'consumed' }
        if (new Date(st.expires_at).getTime() <= this.now()) return { status: 'expired' }
        st.consumed_at = new Date().toISOString()
        return { status: 'ok', company_id: st.company_id, user_id: st.user_id, code_verifier_ciphertext: st.code_verifier_ciphertext, code_verifier_key_version: st.code_verifier_key_version }
      },
      upsertIntegration: async (input) => {
        if (this.integrations.some((r) => r.external_account_id === input.externalAccountId && r.company_id !== input.companyId)) {
          throw new Error('account_linked_to_other_company')
        }
        let row = this.integrations.find((r) => r.company_id === input.companyId && r.provider === 'mercadolivre')
        const reconnected = Boolean(row)
        if (!row) {
          row = {
            id: this.nextId++, company_id: input.companyId, provider: 'mercadolivre', status: 'active', external_account_id: null,
            settings: {}, last_error: null, credential_expires_at: null, credential_refreshed_at: null, last_validated_at: null,
            connected_at: null, disconnected_at: null, oauth_scopes: null, lock_until: null, lock_by: null,
          }
          this.integrations.push(row)
        }
        Object.assign(row, {
          external_account_id: input.externalAccountId, status: 'active', settings: { ...(row.settings ?? {}), ...input.settings },
          last_error: null, credential_expires_at: input.tokenExpiresAt, oauth_scopes: input.tokenScopes,
          credential_refreshed_at: new Date().toISOString(), last_validated_at: new Date().toISOString(),
          connected_at: new Date().toISOString(), disconnected_at: null, lock_until: null, lock_by: null,
        })
        this.putSecrets(row.id, input.companyId, input.accessCiphertext, input.refreshCiphertext, input.keyVersion)
        return { integration_id: row.id, reconnected }
      },
      getIntegration: async (companyId) => {
        const r = this.integrations.find((x) => x.company_id === companyId && x.provider === 'mercadolivre')
        if (!r) return null
        const { lock_until: _l, lock_by: _b, oauth_scopes: _s, provider: _p, ...rest } = r
        return { ...rest }
      },
      updateValidation: async (id, companyId, settings) => {
        const r = this.integrations.find((x) => x.id === id && x.company_id === companyId)
        if (r && (r.status === 'active' || r.status === 'error')) {
          r.settings = { ...(r.settings ?? {}), ...settings }
          r.last_validated_at = new Date().toISOString()
        }
      },
      disconnect: async (id, companyId, userId) => {
        const r = this.integrations.find((x) => x.id === id && x.company_id === companyId)
        if (!r) return false
        r.settings = { ...(r.settings ?? {}), previous_external_account_id: r.external_account_id, disconnected_by: userId }
        Object.assign(r, { status: 'inactive', external_account_id: null, disconnected_at: new Date().toISOString(), credential_expires_at: null, lock_until: null, lock_by: null })
        this.secrets = this.secrets.filter((s) => !(s.integration_id === id && s.company_id === companyId && ['access_token', 'refresh_token'].includes(s.key)))
        return true
      },
    }
  }

  store(): TokenStore {
    const state = (r: Row | undefined): IntegrationTokenState | null => r
      ? { status: r.status, tokenExpiresAt: r.credential_expires_at ? new Date(r.credential_expires_at) : null, tokenRefreshedAt: r.credential_refreshed_at ? new Date(r.credential_refreshed_at) : null }
      : null
    const find = (id: number, companyId: number) => this.integrations.find((r) => r.id === id && r.company_id === companyId)
    return {
      getState: async (id, companyId) => state(find(id, companyId)),
      readTokens: async (id, companyId) => {
        if (!find(id, companyId)) return { accessToken: null, refreshToken: null }
        return { accessToken: this.plainSecret(id, 'access_token'), refreshToken: this.plainSecret(id, 'refresh_token') }
      },
      claim: async (id, companyId, worker, leaseSeconds) => {
        const r = find(id, companyId)
        if (r && r.status === 'active' && (r.lock_until === null || r.lock_until < this.now())) {
          r.lock_until = this.now() + leaseSeconds * 1000
          r.lock_by = worker
          return { claimed: true, state: state(r) }
        }
        return { claimed: false, state: state(r) }
      },
      complete: async (id, companyId, worker, tokens: MercadoLivreTokens) => {
        const r = find(id, companyId)
        if (!r || r.lock_by !== worker) return false
        const a = encryptSecret(tokens.accessToken)
        const f = encryptSecret(tokens.refreshToken)
        this.putSecrets(id, companyId, a.ciphertext, f.ciphertext, a.keyVersion)
        Object.assign(r, { credential_expires_at: tokens.expiresAt.toISOString(), credential_refreshed_at: new Date().toISOString(), last_error: null, lock_until: null, lock_by: null })
        return true
      },
      fail: async (id, companyId, worker, needsReauth, error) => {
        const r = find(id, companyId)
        if (!r || r.lock_by !== worker) return
        if (needsReauth) r.status = 'needs_reauth'
        r.last_error = error
        r.lock_until = null
        r.lock_by = null
      },
    }
  }
}

/**
 * API do Mercado Livre simulada. Refresh token de USO ÚNICO; cada refresh
 * emite um par novo. Permite injetar respostas de erro por rota.
 */
export class FakeMlApi {
  validRefresh = new Set<string>()
  validAccess = new Set<string>()
  refreshCalls = 0
  counter = 0
  calls: Array<{ method: string; url: string; headers: Record<string, string>; body: string | undefined }> = []
  /** Atraso do POST /oauth/token (ms) — para interleaving de workers. */
  tokenDelayMs = 0
  overrides: Array<{ match: (method: string, url: URL) => boolean; response: () => Response; once?: boolean }> = []
  me = { id: 555, nickname: 'LOJA_TESTE', site_id: 'MLB', country_id: 'BR', permalink: 'http://perfil.mercadolivre.com.br/LOJA_TESTE', tags: ['normal', 'test_user'], email: 'nao-persistir@example.com' }
  revoked = false

  issue(): { access_token: string; refresh_token: string; expires_in: number; scope: string; user_id: number; token_type: string } {
    this.counter++
    const access = `APP_USR-access-${this.counter}`
    const refresh = `TG-refresh-${this.counter}`
    this.validAccess.add(access)
    this.validRefresh.add(refresh)
    return { access_token: access, refresh_token: refresh, expires_in: 21600, scope: 'offline_access read write', user_id: this.me.id, token_type: 'bearer' }
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const body = typeof init?.body === 'string' ? init.body : undefined
    this.calls.push({ method, url: url.toString(), headers, body })

    const ov = this.overrides.find((o) => o.match(method, url))
    if (ov) {
      if (ov.once) this.overrides = this.overrides.filter((o) => o !== ov)
      return ov.response()
    }

    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'x-request-id': `req-${this.calls.length}` } })

    if (method === 'POST' && url.pathname === '/oauth/token') {
      if (this.tokenDelayMs) await new Promise((r) => setTimeout(r, this.tokenDelayMs))
      const form = new URLSearchParams(body ?? '')
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'TG-good-code') return json(400, { error: 'invalid_grant', error_description: 'bad code', status: 400 })
        return json(200, this.issue())
      }
      if (form.get('grant_type') === 'refresh_token') {
        this.refreshCalls++
        const rt = form.get('refresh_token') ?? ''
        if (!this.validRefresh.has(rt)) {
          return json(400, { error: 'invalid_grant', error_description: 'Error validating grant. Your authorization code or refresh token may be expired or it was already used', status: 400 })
        }
        this.validRefresh.delete(rt) // uso único
        return json(200, this.issue())
      }
    }

    const token = (headers.authorization ?? '').replace(/^Bearer /, '')
    if (!this.validAccess.has(token)) return json(401, { message: 'invalid access token', error: 'not_found', status: 401 })

    if (method === 'GET' && url.pathname === '/users/me') return json(200, this.me)
    if (method === 'DELETE' && url.pathname.startsWith('/users/') && url.pathname.includes('/applications/')) {
      this.revoked = true
      return json(200, { msg: 'Autorización eliminada' })
    }
    if (method === 'POST' && url.pathname === '/users/test_user') return json(201, { id: 9001, nickname: 'TEST0001', password: 'qatest1', site_status: 'active' })
    return json(404, { message: 'not found' })
  }
}
