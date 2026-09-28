/**
 * Transporte HTTP único para a Shopee Open Platform v2. Nenhuma rota/serviço
 * monta URL da Shopee nem assina requisição por conta própria.
 *
 *   - host vem da config (SHOPEE_API_URL); path é o api_path assinado;
 *   - query comum: partner_id, timestamp, sign (+ access_token, shop_id nas
 *     Shop APIs — a Shopee exige o token NA QUERY, por isso nenhuma
 *     mensagem de erro inclui a URL completa, só o pathname);
 *   - timeout por requisição (AbortController), sem retry interno:
 *     429/5xx/timeout/rede viram ShopeeError `retryable` — quem decide tentar
 *     de novo é a camada chamadora;
 *   - a Shopee pode responder HTTP 200 com `error` preenchido: isso também é
 *     erro e é classificado pelo código.
 *
 * Base para chamadas futuras de catálogo: `auth: { kind: 'shop', ... }`.
 */

import type { ShopeeConfig } from './config'
import { ShopeeError } from './errors'
import { shopeeTimestamp, signPublicRequest, signShopRequest } from './sign'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type ShopeeAuth =
  | { kind: 'public' }
  | { kind: 'shop'; accessToken: string; shopId: number | string }

export interface ShopeeHttpRequest {
  config: Pick<ShopeeConfig, 'partnerId' | 'partnerKey' | 'apiBaseUrl'>
  method: 'GET' | 'POST'
  path: string
  auth: ShopeeAuth
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  timeoutMs?: number
  fetchImpl?: FetchLike
  now?: () => Date
}

export interface ShopeeHttpResponse<T> {
  status: number
  data: T
  requestId: string | null
}

export const DEFAULT_TIMEOUT_MS = 15_000

export async function shopeeHttp<T = Record<string, unknown>>(req: ShopeeHttpRequest): Promise<ShopeeHttpResponse<T>> {
  const fetchImpl = req.fetchImpl ?? (globalThis.fetch as FetchLike)
  const timestamp = shopeeTimestamp((req.now ?? (() => new Date()))())
  const { partnerId, partnerKey } = req.config

  const url = new URL(req.path, `${req.config.apiBaseUrl}/`)
  if (url.pathname !== req.path) throw new ShopeeError('config', 'Path Shopee inválido.')

  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v))
  }
  url.searchParams.set('partner_id', String(partnerId))
  url.searchParams.set('timestamp', String(timestamp))
  if (req.auth.kind === 'shop') {
    url.searchParams.set('access_token', req.auth.accessToken)
    url.searchParams.set('shop_id', String(req.auth.shopId))
    url.searchParams.set('sign', signShopRequest({ partnerId, partnerKey, path: req.path, timestamp, accessToken: req.auth.accessToken, shopId: req.auth.shopId }))
  } else {
    url.searchParams.set('sign', signPublicRequest({ partnerId, partnerKey, path: req.path, timestamp }))
  }

  const headers: Record<string, string> = { accept: 'application/json' }
  let body: string | undefined
  if (req.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(req.body)
  }

  const where = `${req.method} ${req.path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetchImpl(url.toString(), { method: req.method, headers, body, signal: controller.signal })
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError'
    throw new ShopeeError(aborted ? 'timeout' : 'network', aborted ? `Tempo esgotado chamando a Shopee (${where}).` : `Falha de rede chamando a Shopee (${where}).`)
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text().catch(() => '')
  let data: unknown = null
  let parsed = false
  if (text) {
    try { data = JSON.parse(text); parsed = true } catch { data = null }
  }
  const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const requestId = typeof obj.request_id === 'string' ? obj.request_id : res.headers.get('x-request-id')
  const shopeeError = typeof obj.error === 'string' && obj.error.trim() !== '' ? obj.error.trim() : null

  if (res.ok && !shopeeError) {
    if (!parsed || !data || typeof data !== 'object') {
      throw new ShopeeError('invalid_response', `Resposta inválida da Shopee em ${where}.`, { httpStatus: res.status, requestId })
    }
    return { status: res.status, data: data as T, requestId }
  }
  throw toShopeeError(res.status, shopeeError, typeof obj.message === 'string' ? obj.message : '', res.headers.get('retry-after'), requestId, where)
}

/**
 * Classifica o erro. A doc pesquisada não enumera todos os códigos `error`;
 * a classificação por padrão de nome abaixo é deliberadamente conservadora
 * (ver relatório: suposição a validar na homologação).
 */
export function toShopeeError(
  status: number,
  shopeeError: string | null,
  description: string,
  retryAfterHeader: string | null,
  requestId: string | null,
  where: string,
): ShopeeError {
  const message = `Shopee ${status} em ${where}${shopeeError ? ` (${shopeeError})` : ''}${description ? `: ${description}` : ''}`
  const opts = { httpStatus: status, shopeeError, requestId }
  const code = (shopeeError ?? '').toLowerCase()

  if (status === 429 || /too_many|rate_limit|frequen/.test(code)) {
    const retry = Number(retryAfterHeader)
    return new ShopeeError('rate_limited', message, { ...opts, retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : 5 })
  }
  if (status >= 500 || /error_server|error_inner|error_busy|system_busy|timeout/.test(code)) return new ShopeeError('server', message, opts)
  if (status === 403 || /permission|forbidden|no_access/.test(code)) return new ShopeeError('forbidden', message, opts)
  if (status === 401 || /auth|token|sign/.test(code)) return new ShopeeError('unauthorized', message, opts)
  return new ShopeeError('bad_request', message, opts)
}
