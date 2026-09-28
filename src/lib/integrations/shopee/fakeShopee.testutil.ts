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
  liveAccess = new Map<string, string>() // access_token → shop_id
  shop = new FakeShopeeShopApi()
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
    this.liveAccess.set(pair.access_token, shopId)
    return pair
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    this.lastUrl = url
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    this.lastBody = body
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    if (this.mode === 'timeout') { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
    if (this.mode === 'server_error') return this.json({ error: 'error_server', message: 'busy' }, 503)

    const ts = url.searchParams.get('timestamp') ?? ''
    if (url.pathname.startsWith('/api/v2/') && !url.pathname.startsWith('/api/v2/auth/')) {
      const access = url.searchParams.get('access_token') ?? ''
      const shopId = url.searchParams.get('shop_id') ?? ''
      const shopSign = createHmac('sha256', TEST_PARTNER_KEY).update(`${url.searchParams.get('partner_id')}${url.pathname}${ts}${access}${shopId}`).digest('hex')
      if (this.mode === 'bad_sign' || url.searchParams.get('sign') !== shopSign) return this.json({ error: 'error_sign', message: 'Wrong sign.' }, 403)
      if (this.liveAccess.get(access) !== shopId) return this.json({ error: 'error_auth', message: 'Invalid access_token.' }, 403)
      return this.shop.handle(url, init, body, shopId)
    }
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

// ─── Shop API simulada (catálogo, mídia, publicação) ────────────────────────

export type ShopFailure = 'server_error' | 'timeout' | 'bad_request' | 'no_item_id' | 'incomplete' | 'error_200'

export interface FakeShopeeItem {
  item_id: number
  shop_id: string
  body: Record<string, unknown>
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * Loja(s) Shopee simuladas. Categorias/atributos/marcas/canais são dados de
 * TESTE (nunca usados em produção). Itens ficam por shop_id — item de outra
 * loja não aparece em get_item_base_info.
 */
export class FakeShopeeShopApi {
  categories: Array<Record<string, unknown>> = [
    { category_id: 100, parent_category_id: 0, original_category_name: 'Women Clothes', display_category_name: 'Roupas Femininas', has_children: true },
    { category_id: 101, parent_category_id: 100, original_category_name: 'Lingerie', display_category_name: 'Lingerie', has_children: true },
    { category_id: 102, parent_category_id: 101, original_category_name: 'Bras', display_category_name: 'Sutiãs', has_children: false },
    { category_id: 200, parent_category_id: 0, original_category_name: 'Home', display_category_name: 'Casa', has_children: false },
  ]
  attributeTrees: Record<number, Array<Record<string, unknown>>> = {
    102: [
      { attribute_id: 1001, mandatory: true, name: 'Material', attribute_value_list: [{ value_id: 11, name: 'Algodão' }, { value_id: 12, name: 'Renda' }], attribute_info: { input_type: 1, input_validation_type: 0, format_type: 1, max_value_count: 1 } },
      { attribute_id: 1002, mandatory: false, name: 'Estilo', attribute_value_list: [], attribute_info: { input_type: 3, input_validation_type: 2, format_type: 1 } },
      { attribute_id: 1003, mandatory: false, name: 'Estampa', attribute_value_list: [{ value_id: 31, name: 'Lisa' }, { value_id: 32, name: 'Floral' }], attribute_info: { input_type: 4, input_validation_type: 0, format_type: 1, max_value_count: 2 } },
    ],
    200: [],
  }
  brands: Record<number, { is_mandatory: boolean; list: Array<Record<string, unknown>> }> = {
    102: { is_mandatory: true, list: [{ brand_id: 0, original_brand_name: 'No Brand', display_brand_name: 'No Brand' }, { brand_id: 5001, original_brand_name: 'Santtorini', display_brand_name: 'Santtorini' }] },
    200: { is_mandatory: false, list: [] },
  }
  channels: Array<Record<string, unknown>> = [
    { logistics_channel_id: 90001, logistics_channel_name: 'Shopee Xpress', enabled: true, fee_type: 'SIZE_INPUT', weight_limit: { item_max_weight: 30, item_min_weight: 0.01 } },
    { logistics_channel_id: 90002, logistics_channel_name: 'Correios', enabled: false, fee_type: 'SIZE_INPUT', weight_limit: { item_max_weight: 30, item_min_weight: 0.01 } },
  ]
  items: FakeShopeeItem[] = []
  uploads: Array<{ shop_id: string; size: number; type: string }> = []
  addItemCalls: Array<{ shop_id: string; body: Record<string, unknown> }> = []
  calls: Array<{ path: string; shop_id: string }> = []
  /** Falha forçada por path (ex.: '/api/v2/product/add_item'). */
  fail = new Map<string, ShopFailure>()
  /** Força shop_id divergente no item devolvido por get_item_base_info. */
  reportShopIdOverride: string | null = null
  /** Consistência eventual: get_item_base_info não vê itens novos. */
  hideNewItems = false
  /** Cria o item e DEPOIS responde a falha (timeout/5xx ambíguos). */
  createThenFail = false
  private nextItemId = 800000
  private nextImage = 1

  async handle(url: URL, init: RequestInit | undefined, body: Record<string, unknown>, shopId: string): Promise<Response> {
    const path = url.pathname
    this.calls.push({ path, shop_id: shopId })
    const failure = this.fail.get(path)
    if (failure && !(this.createThenFail && path === '/api/v2/product/add_item')) {
      const r = this.failure(failure)
      if (r) return r
    }
    switch (path) {
      case '/api/v2/product/get_category':
        if (failure === 'incomplete') return json({ error: '', response: { category_list: [{ category_id: 1 }] } })
        return json({ error: '', message: '', request_id: 'r', response: { category_list: this.categories } })
      case '/api/v2/product/get_attribute_tree': {
        const id = Number(url.searchParams.get('category_id_list'))
        if (!(id in this.attributeTrees)) return json({ error: 'product.error_invalid_category', message: 'Invalid category ID' }, 400)
        return json({ error: '', response: { list: [{ category_id: id, attribute_tree: this.attributeTrees[id] }] } })
      }
      case '/api/v2/product/get_brand_list': {
        const id = Number(url.searchParams.get('category_id'))
        const b = this.brands[id] ?? { is_mandatory: false, list: [] }
        const offset = Number(url.searchParams.get('offset') ?? 0)
        const size = Number(url.searchParams.get('page_size') ?? 100)
        const page = b.list.slice(offset, offset + size)
        return json({ error: '', response: { brand_list: page, has_next_page: offset + size < b.list.length, next_offset: offset + size, is_mandatory: b.is_mandatory, input_type: 'DROP_DOWN' } })
      }
      case '/api/v2/logistics/get_channel_list':
        return json({ error: '', response: { logistics_channel_list: this.channels } })
      case '/api/v2/media_space/upload_image': {
        const form = init?.body
        if (!(form instanceof FormData)) return json({ error: 'error_param', message: 'multipart esperado' }, 400)
        const file = form.get('image')
        if (!(file instanceof Blob)) return json({ error: 'error_param', message: 'sem image' }, 400)
        this.uploads.push({ shop_id: shopId, size: file.size, type: file.type })
        return json({ error: '', response: { image_info: { image_id: `img-${shopId}-${this.nextImage++}`, image_url_list: [] } } })
      }
      case '/api/v2/product/add_item': {
        this.addItemCalls.push({ shop_id: shopId, body })
        const item: FakeShopeeItem = { item_id: this.nextItemId++, shop_id: shopId, body }
        this.items.push(item)
        if (failure) {
          const r = this.failure(failure)
          if (r) return r
        }
        return json({ error: '', message: '', warning: '', request_id: 'r-add', response: {
          item_id: item.item_id, item_status: body.item_status ?? 'NORMAL', category_id: body.category_id, item_name: body.item_name,
          item_sku: body.item_sku, price_info: { original_price: body.original_price, current_price: body.original_price },
          images: { image_id_list: (body.image as { image_id_list?: string[] })?.image_id_list ?? [] },
        } })
      }
      case '/api/v2/product/get_item_base_info': {
        const ids = String(url.searchParams.get('item_id_list') ?? '').split(',').map(Number)
        const list = this.hideNewItems ? [] : this.items.filter((i) => ids.includes(i.item_id) && i.shop_id === shopId)
        return json({ error: '', response: { item_list: list.map((i) => ({
          item_id: i.item_id, category_id: i.body.category_id, item_name: i.body.item_name, item_sku: i.body.item_sku,
          item_status: i.body.item_status ?? 'NORMAL', condition: i.body.condition,
          price_info: [{ currency: 'BRL', original_price: i.body.original_price, current_price: i.body.original_price }],
          stock_info_v2: { summary_info: { total_available_stock: (i.body.seller_stock as Array<{ stock: number }>)?.[0]?.stock ?? 0 } },
          image: { image_id_list: (i.body.image as { image_id_list?: string[] })?.image_id_list ?? [] },
          ...(this.reportShopIdOverride ? { shop_id: Number(this.reportShopIdOverride) } : {}),
        })) } })
      }
      default:
        return json({ error: 'error_not_found', message: 'no route' }, 404)
    }
  }

  private failure(f: ShopFailure): Response | null {
    if (f === 'server_error') return json({ error: 'error_server', message: 'busy' }, 503)
    if (f === 'timeout') { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
    if (f === 'bad_request') return json({ error: 'product.error_param', message: 'Wrong parameters' }, 400)
    if (f === 'error_200') return json({ error: 'product.error_param', message: 'item_name too long' }, 200)
    if (f === 'no_item_id') return json({ error: '', response: {} })
    return null
  }
}

/** Downloader de teste: nunca vai à rede; JPEG mínimo. */
export function fakeImageDownloader(opts: { failFor?: string[] } = {}) {
  const calls: string[] = []
  const download = async (url: string) => {
    calls.push(url)
    if (opts.failFor?.includes(url)) {
      const { ShopeeError } = await import('./errors')
      throw new ShopeeError('network', 'Falha ao baixar imagem do Media Hub.', { nothingCreated: true })
    }
    return { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), contentType: 'image/jpeg', filename: 'image.jpg' }
  }
  return { download, calls }
}
