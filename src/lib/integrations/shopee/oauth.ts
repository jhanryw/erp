/**
 * Autorização de loja na Shopee Open Platform v2 (Brasil):
 *
 *   autorização: GET {SHOPEE_AUTH_URL}/auth?partner_id&auth_type=seller
 *                &redirect_uri&response_type=code&state
 *                → callback ?code&shop_id(&state). `code` expira em 10 min.
 *   token:       POST {SHOPEE_API_URL}/api/v2/auth/token/get
 *                query partner_id,timestamp,sign (Public API)
 *                body { code, partner_id, shop_id }
 *   refresh:     POST {SHOPEE_API_URL}/api/v2/auth/access_token/get
 *                body { refresh_token, partner_id, shop_id }
 *   access_token ~4h (`expire_in` em segundos). refresh_token 30 dias e de
 *   USO ÚNICO: cada refresh devolve um par novo que precisa ser gravado.
 *
 * Sem PKCE (não existe no protocolo da Shopee): só state anti-CSRF, guardado
 * como hash no banco. Funções puras + transporte injetável (fetchImpl).
 */

import { createHash, randomBytes } from 'node:crypto'
import { SHOPEE_PATHS, type ShopeeConfig } from './config'
import { ShopeeError, isShopeeError } from './errors'
import { shopeeHttp, type FetchLike } from './http'
import type { ShopeeTokenResponse, ShopeeTokens } from './types'

/** Tempo de vida do state OAuth no banco (igual ao `code` da Shopee: 10 min). */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60

export function generateOAuthState(): string {
  return randomBytes(32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** O banco só guarda o hash do state. */
export function hashOAuthState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex')
}

export function isValidShopId(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{1,20}$/.test(value) && value !== '0'
}

export function buildAuthorizationUrl(input: { config: ShopeeConfig; state: string }): string {
  const url = new URL(`${input.config.authBaseUrl}${SHOPEE_PATHS.authorize}`)
  url.searchParams.set('partner_id', String(input.config.partnerId))
  url.searchParams.set('auth_type', 'seller')
  url.searchParams.set('redirect_uri', input.config.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', input.state)
  return url.toString()
}

export function parseTokenResponse(data: unknown, shopId: string, now: Date = new Date()): ShopeeTokens {
  const t = (data ?? {}) as ShopeeTokenResponse
  if (!t.access_token || !t.refresh_token || typeof t.expire_in !== 'number' || !(t.expire_in > 0)) {
    throw new ShopeeError('invalid_response', 'Resposta de token da Shopee incompleta.')
  }
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: new Date(now.getTime() + t.expire_in * 1000),
    shopId,
  }
}

export async function exchangeCodeForTokens(input: {
  config: ShopeeConfig
  code: string
  shopId: string
  fetchImpl?: FetchLike
  now?: () => Date
}): Promise<ShopeeTokens> {
  if (!input.code) throw new ShopeeError('invalid_callback', 'Callback sem code.')
  if (!isValidShopId(input.shopId)) throw new ShopeeError('invalid_callback', 'shop_id inválido.')
  const res = await shopeeHttp<ShopeeTokenResponse>({
    config: input.config,
    method: 'POST',
    path: SHOPEE_PATHS.tokenGet,
    auth: { kind: 'public' },
    body: { code: input.code, partner_id: input.config.partnerId, shop_id: Number(input.shopId) },
    fetchImpl: input.fetchImpl,
    now: input.now,
  })
  return parseTokenResponse(res.data, input.shopId, (input.now ?? (() => new Date()))())
}

/**
 * Troca o refresh_token (uso único) por um par novo. Recusa não transitória
 * (token inválido/expirado/já usado) vira `reauth_required` — o chamador NÃO
 * deve repetir com o mesmo refresh_token. Erros de assinatura (`sign`)
 * continuam `unauthorized` (problema de configuração do app, não da loja).
 */
export async function refreshTokens(input: {
  config: ShopeeConfig
  refreshToken: string
  shopId: string
  fetchImpl?: FetchLike
  now?: () => Date
}): Promise<ShopeeTokens> {
  if (!isValidShopId(input.shopId)) throw new ShopeeError('integration_not_found', 'shop_id da integração inválido.')
  try {
    const res = await shopeeHttp<ShopeeTokenResponse>({
      config: input.config,
      method: 'POST',
      path: SHOPEE_PATHS.accessTokenGet,
      auth: { kind: 'public' },
      body: { refresh_token: input.refreshToken, partner_id: input.config.partnerId, shop_id: Number(input.shopId) },
      fetchImpl: input.fetchImpl,
      now: input.now,
    })
    return parseTokenResponse(res.data, input.shopId, (input.now ?? (() => new Date()))())
  } catch (err) {
    if (isShopeeError(err) && isRefreshRejection(err)) {
      throw new ShopeeError('reauth_required', err.message, { httpStatus: err.httpStatus, shopeeError: err.shopeeError, requestId: err.requestId })
    }
    throw err
  }
}

function isRefreshRejection(err: ShopeeError): boolean {
  if (err.retryable || err.kind === 'invalid_response' || err.kind === 'config') return false
  if (/sign/i.test(err.shopeeError ?? '')) return false
  return err.kind === 'unauthorized' || err.kind === 'forbidden' || err.kind === 'bad_request'
}
