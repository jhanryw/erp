/**
 * Chamada autenticada à Shop API da Shopee em nome de UMA loja
 * (integration_id + company_id + shop_id). Único ponto por onde catálogo e
 * publicação falam com a Shopee — mesmo desenho de mercadolivre/client.ts:
 *
 *   - token via tokens.getValidAccessToken (lease; refresh de uso único);
 *   - assinatura Shop API em http.ts/sign.ts (nada é assinado aqui);
 *   - `unauthorized` → UMA renovação forçada (só se ninguém renovou antes)
 *     e UMA nova tentativa; sem laço;
 *   - 429/5xx/timeout → ShopeeError `retryable`; sem retry interno.
 *
 * companyId é obrigatório e conferido no banco em toda leitura de
 * estado/segredo (store) — nunca confia só no integrationId.
 */

import { getShopeeConfig, type ShopeeConfig } from './config'
import { ShopeeError, isShopeeError } from './errors'
import { shopeeHttp, type FetchLike, type ShopeeHttpResponse } from './http'
import { logShopee } from './log'
import { refreshTokens } from './oauth'
import { createSupabaseShopeeTokenStore, getValidAccessToken, type ShopeeTokenStore } from './tokens'

export interface ShopeeRequestDeps {
  config?: ShopeeConfig
  store?: ShopeeTokenStore
  fetchImpl?: FetchLike
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

/** Identifica a loja: SEMPRE a integração exata (multi-loja), nunca só o provider. */
export interface ShopeeShopContext {
  integrationId: number
  companyId: number
  shopId: string
  deps?: ShopeeRequestDeps
}

export interface ShopeeShopRequest {
  method: 'GET' | 'POST'
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  form?: FormData
  timeoutMs?: number
}

export async function shopeeShopRequest<T = Record<string, unknown>>(ctx: ShopeeShopContext, req: ShopeeShopRequest): Promise<ShopeeHttpResponse<T>> {
  if (!/^\d{1,20}$/.test(ctx.shopId)) throw new ShopeeError('integration_not_found', 'shop_id da integração inválido.')
  const deps = ctx.deps ?? {}
  const config = deps.config ?? getShopeeConfig()
  const store = deps.store ?? createSupabaseShopeeTokenStore()
  const tokenInput = {
    integrationId: ctx.integrationId,
    companyId: ctx.companyId,
    store,
    refresh: (rt: string) => refreshTokens({ config, refreshToken: rt, shopId: ctx.shopId, fetchImpl: deps.fetchImpl, now: deps.now }),
    now: deps.now,
    sleep: deps.sleep,
  }
  const send = (accessToken: string) => shopeeHttp<T>({
    config,
    method: req.method,
    path: req.path,
    auth: { kind: 'shop', accessToken, shopId: ctx.shopId },
    query: req.query,
    body: req.body,
    form: req.form,
    timeoutMs: req.timeoutMs,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  })

  const first = await getValidAccessToken(tokenInput)
  try {
    return await send(first.accessToken)
  } catch (err) {
    if (!isTokenRejection(err) || first.refreshed) {
      logApiError(ctx, req.path, err)
      throw err
    }
    const second = await getValidAccessToken({ ...tokenInput, forceIfExpiresAt: first.expiresAt ?? new Date(0) })
    try {
      return await send(second.accessToken)
    } catch (retryErr) {
      logApiError(ctx, req.path, retryErr)
      throw retryErr
    }
  }
}

/**
 * Token recusado pela Shopee. A doc lista `error_auth` ("Invalid
 * access_token") mas não fixa o HTTP status (401 ou 403) — por isso olha o
 * código. Erro de assinatura (`sign`) é configuração do app: não renova.
 */
function isTokenRejection(err: unknown): boolean {
  if (!isShopeeError(err) || /sign/i.test(err.shopeeError ?? '')) return false
  return err.kind === 'unauthorized' || (err.kind === 'forbidden' && /error_auth|access_token|invalid_token/i.test(err.shopeeError ?? ''))
}

function logApiError(ctx: ShopeeShopContext, path: string, err: unknown): void {
  const e = isShopeeError(err) ? err : new ShopeeError('network', 'erro inesperado')
  logShopee('shopee.api.error', {
    company_id: ctx.companyId, integration_id: ctx.integrationId, shop_id: ctx.shopId,
    http_status: e.httpStatus, request_id: e.requestId, reason: e.kind, path,
  })
}

/** `response` do envelope Shopee ({error,message,request_id,response}). */
export function shopeeResponseBody(data: unknown, where: string): Record<string, unknown> {
  const r = (data as { response?: unknown } | null)?.response
  if (!r || typeof r !== 'object') throw new ShopeeError('invalid_response', `Resposta sem "response" em ${where}.`)
  return r as Record<string, unknown>
}
