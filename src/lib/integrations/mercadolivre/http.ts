/**
 * Transporte HTTP único para a API do Mercado Livre. Nenhuma rota/serviço
 * faz `fetch('https://api.mercadolibre.com/…')` diretamente.
 *
 *   - timeout por requisição (AbortController), sem retry interno: 429/5xx/
 *     timeout viram MercadoLivreError com `retryable=true` e `retryAfterSeconds`
 *     — quem decide tentar de novo é a camada chamadora (fila nas próximas fases);
 *   - token SEMPRE no header Authorization (exigência da doc oficial), nunca
 *     na query string;
 *   - corpo de erro da API é resumido e redigido (sem ecoar credenciais).
 */

import { MercadoLivreError, parseMercadoLivreCauses } from './errors'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface MlHttpRequest {
  baseUrl: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  query?: Record<string, string | number | boolean | undefined>
  /** JSON body */
  body?: unknown
  /** application/x-www-form-urlencoded body (OAuth /oauth/token) */
  form?: Record<string, string>
  accessToken?: string | null
  timeoutMs?: number
  fetchImpl?: FetchLike
  /** Headers de formato exigidos por alguns recursos (ex.: x-format-new). Nunca authorization. */
  headers?: Record<string, string>
}

export interface MlHttpResponse<T> {
  status: number
  data: T
  requestId: string | null
}

export const DEFAULT_TIMEOUT_MS = 15_000

export async function mlHttp<T = unknown>(req: MlHttpRequest): Promise<MlHttpResponse<T>> {
  const fetchImpl = req.fetchImpl ?? (globalThis.fetch as FetchLike)
  const url = new URL(req.path.startsWith('/') ? req.path : `/${req.path}`, req.baseUrl)
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v))
  }

  const headers: Record<string, string> = { accept: 'application/json' }
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (/^x-[a-z0-9-]+$/i.test(k)) headers[k.toLowerCase()] = v
  }
  let body: string | undefined
  if (req.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(req.form).toString()
  } else if (req.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(req.body)
  }
  if (req.accessToken) headers.authorization = `Bearer ${req.accessToken}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  let res: Response
  try {
    res = await fetchImpl(url.toString(), { method: req.method, headers, body, signal: controller.signal })
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError'
    throw new MercadoLivreError(
      aborted ? 'timeout' : 'network',
      aborted ? `Tempo esgotado chamando o Mercado Livre (${req.method} ${url.pathname}).` : `Falha de rede chamando o Mercado Livre (${req.method} ${url.pathname}).`,
    )
  } finally {
    clearTimeout(timer)
  }

  const requestId = res.headers.get('x-request-id')
  const text = await res.text().catch(() => '')
  let data: unknown = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = text }
  }

  if (res.ok) return { status: res.status, data: data as T, requestId }
  throw toMercadoLivreError(res.status, data, res.headers.get('retry-after'), requestId, `${req.method} ${url.pathname}`)
}

export function toMercadoLivreError(
  status: number,
  data: unknown,
  retryAfterHeader: string | null,
  requestId: string | null,
  where: string,
): MercadoLivreError {
  const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const mlError = typeof obj.error === 'string' ? obj.error : null
  const description = typeof obj.error_description === 'string'
    ? obj.error_description
    : typeof obj.message === 'string' ? obj.message : ''
  const message = `Mercado Livre ${status} em ${where}${mlError ? ` (${mlError})` : ''}${description ? `: ${description}` : ''}`
  const opts = { httpStatus: status, mlError, requestId, causes: parseMercadoLivreCauses(data) }

  if (mlError === 'invalid_grant') return new MercadoLivreError('reauth_required', message, opts)
  if (status === 429) {
    const retry = Number(retryAfterHeader)
    return new MercadoLivreError('rate_limited', message, { ...opts, retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : 5 })
  }
  if (status >= 500) return new MercadoLivreError('server', message, opts)
  if (status === 401) return new MercadoLivreError('unauthorized', message, opts)
  if (status === 403) return new MercadoLivreError('forbidden', message, opts)
  if (status === 404) return new MercadoLivreError('not_found', message, opts)
  return new MercadoLivreError('bad_request', message, opts)
}
