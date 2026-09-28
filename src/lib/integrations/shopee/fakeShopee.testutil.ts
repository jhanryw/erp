/**
 * Doubles de teste (NÃO usados em produção) com a mesma semântica das RPCs
 * genéricas de OAuth (202609241000) e da rpc_upsert_oauth_account_integration
 * (202609281000):
 *   - FakeShopeeDb: company_integrations + integration_secrets + oauth_states,
 *     multi-loja, lease atômico entre awaits;
 *   - FakeShopeeApi: servidor Shopee simulado — confere a assinatura e usa
 *     refresh_token de USO ÚNICO (reusar = erro), como a API real.
 */

import { createHmac } from 'node:crypto'
import { decryptSecret, encryptSecret } from '@/lib/security/secretCipher'
import type { ConsumeStateResult, ShopeeIntegrationRow, ShopeeRepo } from '@/services/integrations/shopee.service'
import type { ShopeeConfig } from './config'
import type { IntegrationTokenState, ShopeeTokenStore } from './tokens'

export function setTestCipherEnv(): void {
  process.env.INTEGRATION_SECRETS_CURRENT_KEY_VERSION = '1'
  process.env.INTEGRATION_SECRETS_MASTER_KEY_V1 = Buffer.alloc(32, 7).toString('base64')
}

export const TEST_PARTNER_KEY = 'shpk-partner-key-SUPER-SECRET-0123456789'

export const TEST_CONFIG: ShopeeConfig = {
  partnerId: 2001234,
  partnerKey: TEST_PARTNER_KEY,
  redirectUri: 'https://erp.example.com/api/integrations/shopee/callback',
  authBaseUrl: 'https://open.shopee.com.br',
  apiBaseUrl: 'https://openplatform.shopee.com.br',
}

interface Row extends ShopeeIntegrationRow {
  provider: string
  lock_until: number | null
  lock_by: string | null
}

export class FakeShopeeDb {
  integrations: Row[] = []
  secrets: Array<{ integration_id: number; company_id: number; key: string; ciphertext: string; key_version: number }> = []
  states: Array<{ state_hash: string; company_id: number; user_id: string; expires_at: string; consumed_at: string | null }> = []
  nextId = 1
  now: () => number = () => Date.now()

  private putSecrets(integrationId: number, companyId: number, access: string, refresh: string, keyVersion: number) {
    this.secrets = this.secrets.filter((s) => !(s.integration_id === integrationId && (s.key === 'access_token' || s.key === 'refresh_token')))
    this.secrets.push({ integration_id: integrationId, company_id: companyId, key: 'access_token', ciphertext: access, key_version: keyVersion })
    this.secrets.push({ integration_id: integrationId, company_id: companyId, key: 'refresh_token', ciphertext: refresh, key_version: keyVersion })
  }

  seedConnected(companyId: number, shopId: string, tokens: { access: string; refresh: string; expiresAt: Date }, provider = 'shopee'): number {
    const id = this.nextId++
    this.integrations.push({
      id, company_id: companyId, provider, status: 'active', external_account_id: shopId,
      settings: { shop_id: shopId }, last_error: null, credential_expires_at: tokens.expiresAt.toISOString(),
      credential_refreshed_at: null, connected_at: new Date().toISOString(), disconnected_at: null, lock_until: null, lock_by: null,
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

  private view(r: Row): ShopeeIntegrationRow {
    const { lock_until: _l, lock_by: _b, provider: _p, ...rest } = r
    return { ...rest }
  }

  repo(): ShopeeRepo {
    return {
      insertOAuthState: async (row) => { this.states.push({ ...row, consumed_at: null }) },
      consumeOAuthState: async (hash): Promise<ConsumeStateResult> => {
        const st = this.states.find((s) => s.state_hash === hash)
        if (!st) return { status: 'not_found' }
        if (st.consumed_at) return { status: 'consumed' }
        if (new Date(st.expires_at).getTime() <= this.now()) return { status: 'expired' }
        st.consumed_at = new Date().toISOString()
        return { status: 'ok', company_id: st.company_id, user_id: st.user_id }
      },
      upsertIntegration: async (input) => {
        if (this.integrations.some((r) => r.provider === 'shopee' && r.external_account_id === input.shopId && r.company_id !== input.companyId)) {
          throw new Error('account_linked_to_other_company')
        }
        let row = this.integrations.find((r) => r.company_id === input.companyId && r.provider === 'shopee'
          && (r.external_account_id === input.shopId
            || (r.external_account_id === null && (r.settings as Record<string, unknown> | null)?.previous_external_account_id === input.shopId)))
        const reconnected = Boolean(row)
        if (!row) {
          row = {
            id: this.nextId++, company_id: input.companyId, provider: 'shopee', status: 'active', external_account_id: null,
            settings: {}, last_error: null, credential_expires_at: null, credential_refreshed_at: null,
            connected_at: null, disconnected_at: null, lock_until: null, lock_by: null,
          }
          this.integrations.push(row)
        }
        Object.assign(row, {
          external_account_id: input.shopId, status: 'active', settings: { ...(row.settings ?? {}), ...input.settings },
          last_error: null, credential_expires_at: input.tokenExpiresAt, credential_refreshed_at: new Date().toISOString(),
          connected_at: new Date().toISOString(), disconnected_at: null, lock_until: null, lock_by: null,
        })
        this.putSecrets(row.id, input.companyId, input.accessCiphertext, input.refreshCiphertext, input.keyVersion)
        return { integration_id: row.id, reconnected }
      },
      listIntegrations: async (companyId) =>
        this.integrations.filter((x) => x.company_id === companyId && x.provider === 'shopee').map((r) => this.view(r)),
      getIntegration: async (companyId, id) => {
        const r = this.integrations.find((x) => x.id === id && x.company_id === companyId && x.provider === 'shopee')
        return r ? this.view(r) : null
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

  store(): ShopeeTokenStore {
    const state = (r: Row | undefined): IntegrationTokenState | null => r
      ? { status: r.status, tokenExpiresAt: r.credential_expires_at ? new Date(r.credential_expires_at) : null, tokenRefreshedAt: r.credential_refreshed_at ? new Date(r.credential_refreshed_at) : null }
      : null
    const find = (id: number, companyId: number) => this.integrations.find((r) => r.id === id && r.company_id === companyId && r.provider === 'shopee')
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
      complete: async (id, companyId, worker, tokens) => {
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
        Object.assign(r, { status: needsReauth ? 'needs_reauth' : r.status, last_error: error, lock_until: null, lock_by: null })
      },
    }
  }
}

type Mode = 'ok' | 'server_error' | 'timeout' | 'bad_sign'

/** Servidor Shopee simulado para /api/v2/auth/token/get e /api/v2/auth/access_token/get. */
export class FakeShopeeApi {
  codes = new Map<string, string>() // code → shop_id
  liveRefresh = new Map<string, string>() // refresh_token → shop_id (uso único)
  tokenCalls = 0
  refreshCalls = 0
  mode: Mode = 'ok'
  delayMs = 0
  lastUrl: URL | null = null
  lastBody: Record<string, unknown> | null = null
  private seq = 0

  issue(shopId: string): { access_token: string; refresh_token: string } {
    this.seq++
    const pair = { access_token: `acc-${shopId}-${this.seq}`, refresh_token: `ref-${shopId}-${this.seq}` }
    this.liveRefresh.set(pair.refresh_token, shopId)
    return pair
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    this.lastUrl = url
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    this.lastBody = body
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    if (this.mode === 'timeout') { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
    if (this.mode === 'server_error') return this.json({ error: 'error_server', message: 'busy' }, 503)

    const ts = url.searchParams.get('timestamp') ?? ''
    const expected = createHmac('sha256', TEST_PARTNER_KEY).update(`${url.searchParams.get('partner_id')}${url.pathname}${ts}`).digest('hex')
    if (this.mode === 'bad_sign' || url.searchParams.get('sign') !== expected) {
      return this.json({ error: 'error_sign', message: 'Wrong sign.' }, 403)
    }

    if (url.pathname === '/api/v2/auth/token/get') {
      this.tokenCalls++
      const shop = this.codes.get(String(body.code))
      if (!shop || String(body.shop_id) !== shop) return this.json({ error: 'error_param', message: 'Invalid code' }, 400)
      this.codes.delete(String(body.code))
      return this.json({ ...this.issue(shop), expire_in: 14400, request_id: 'req-1', error: '', message: '' })
    }
    if (url.pathname === '/api/v2/auth/access_token/get') {
      this.refreshCalls++
      const rt = String(body.refresh_token)
      const shop = this.liveRefresh.get(rt)
      if (!shop || String(body.shop_id) !== shop) return this.json({ error: 'error_auth', message: 'Invalid refresh_token' }, 403)
      this.liveRefresh.delete(rt)
      return this.json({ ...this.issue(shop), expire_in: 14400, shop_id: Number(shop), request_id: 'req-2', error: '', message: '' })
    }
    return this.json({ error: 'error_not_found', message: 'no route' }, 404)
  }
}
