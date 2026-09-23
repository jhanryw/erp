/**
 * OAuth 2.0 (Authorization Code, server side) do Mercado Livre — conforme a
 * documentação oficial "Autenticação e Autorização" (atualizada 29/12/2025):
 *
 *   autorização: https://auth.<dominio-do-site>/authorization
 *                ?response_type=code&client_id&redirect_uri&state
 *                [&code_challenge&code_challenge_method=S256]  (PKCE)
 *   token:       POST https://api.mercadolibre.com/oauth/token
 *                form-urlencoded NO CORPO (nunca query string)
 *                grant_type=authorization_code|refresh_token
 *   access_token: 6h. refresh_token: uso único, só o último vale, 6 meses.
 *
 * Funções puras + transporte injetável (fetchImpl) — testáveis sem rede.
 */

import { createHash, randomBytes } from 'node:crypto'
import { authorizationBaseUrl, type MercadoLivreConfig } from './config'
import { MercadoLivreError } from './errors'
import { mlHttp, type FetchLike } from './http'
import type { MercadoLivreTokenResponse, MercadoLivreTokens } from './types'

/** Tempo de vida do state OAuth no banco. */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** State criptograficamente aleatório (256 bits), único por tentativa. */
export function generateOAuthState(): string {
  return base64url(randomBytes(32))
}

/** O banco só guarda o hash do state — vazamento do banco não permite forjar callbacks. */
export function hashOAuthState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex')
}

export interface PkcePair {
  verifier: string
  challenge: string
  method: 'S256'
}

/** PKCE S256 (RFC 7636): verifier 43-128 chars, challenge = base64url(sha256(verifier)). */
export function generatePkcePair(): PkcePair {
  const verifier = base64url(randomBytes(48)) // 64 chars
  const challenge = base64url(createHash('sha256').update(verifier, 'ascii').digest())
  return { verifier, challenge, method: 'S256' }
}

export function buildAuthorizationUrl(input: {
  config: MercadoLivreConfig
  state: string
  codeChallenge?: string | null
  siteId?: string
}): string {
  const url = new URL(authorizationBaseUrl(input.siteId ?? input.config.defaultSiteId))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.config.clientId)
  url.searchParams.set('redirect_uri', input.config.redirectUri)
  url.searchParams.set('state', input.state)
  if (input.config.usePkce) {
    if (!input.codeChallenge) throw new MercadoLivreError('config', 'PKCE habilitado mas code_challenge ausente.')
    url.searchParams.set('code_challenge', input.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
  }
  return url.toString()
}

export function parseTokenResponse(data: unknown, now: Date = new Date()): MercadoLivreTokens {
  const t = (data ?? {}) as Partial<MercadoLivreTokenResponse>
  if (!t.access_token || !t.refresh_token || typeof t.expires_in !== 'number' || t.user_id == null) {
    throw new MercadoLivreError('bad_request', 'Resposta de token do Mercado Livre incompleta.')
  }
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: new Date(now.getTime() + t.expires_in * 1000),
    scopes: (t.scope ?? '').split(/\s+/).filter(Boolean),
    userId: String(t.user_id),
  }
}

export async function exchangeCodeForTokens(input: {
  config: MercadoLivreConfig
  code: string
  codeVerifier?: string | null
  fetchImpl?: FetchLike
}): Promise<MercadoLivreTokens> {
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    code: input.code,
    redirect_uri: input.config.redirectUri,
  }
  if (input.config.usePkce) {
    if (!input.codeVerifier) throw new MercadoLivreError('invalid_state', 'code_verifier PKCE ausente para este state.')
    form.code_verifier = input.codeVerifier
  }
  const res = await mlHttp({ baseUrl: input.config.apiBaseUrl, method: 'POST', path: '/oauth/token', form, fetchImpl: input.fetchImpl })
  return parseTokenResponse(res.data)
}

/**
 * Troca o refresh_token (uso único) por um par novo. `invalid_grant` vira
 * `reauth_required` (revogado/expirado/já usado) — o chamador NÃO deve
 * repetir com o mesmo refresh_token.
 */
export async function refreshTokens(input: {
  config: MercadoLivreConfig
  refreshToken: string
  fetchImpl?: FetchLike
}): Promise<MercadoLivreTokens> {
  const res = await mlHttp({
    baseUrl: input.config.apiBaseUrl,
    method: 'POST',
    path: '/oauth/token',
    form: {
      grant_type: 'refresh_token',
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      refresh_token: input.refreshToken,
    },
    fetchImpl: input.fetchImpl,
  })
  return parseTokenResponse(res.data)
}
