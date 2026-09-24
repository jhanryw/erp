/**
 * Chamada autenticada à API do Mercado Livre em nome de UMA integração.
 * Único ponto por onde as próximas fases (anúncios, pedidos, estoque)
 * devem falar com o Mercado Livre.
 *
 *   mercadoLivreRequest({ integrationId, companyId, method, path, body })
 *
 *   - carrega/renova o token (tokens.getValidAccessToken, com lease);
 *   - envia Authorization: Bearer (nunca na URL);
 *   - 401 → UMA renovação forçada (só se ninguém renovou antes) e UMA nova
 *     tentativa; persiste 401 → erro `unauthorized`. Sem laço infinito.
 *   - 429/5xx/timeout → MercadoLivreError `retryable` (com retryAfterSeconds
 *     no 429). Sem retry dentro da requisição HTTP do usuário.
 *   - companyId é obrigatório e conferido no banco em toda leitura de
 *     estado/segredo — nunca confia só no integrationId.
 */

import { getMercadoLivreConfig, type MercadoLivreConfig } from './config'
import { MercadoLivreError, isMercadoLivreError } from './errors'
import { mlHttp, type FetchLike, type MlHttpResponse } from './http'
import { logMercadoLivre } from './log'
import { refreshTokens } from './oauth'
import { createSupabaseTokenStore, getValidAccessToken, type TokenStore } from './tokens'

export interface MercadoLivreRequestDeps {
  config?: MercadoLivreConfig
  store?: TokenStore
  fetchImpl?: FetchLike
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  workerId?: string
}

export interface MercadoLivreRequestInput {
  integrationId: number
  companyId: number
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  timeoutMs?: number
  /** Headers x-* de formato (ex.: x-format-new: true). */
  headers?: Record<string, string>
  deps?: MercadoLivreRequestDeps
}

export async function mercadoLivreRequest<T = unknown>(input: MercadoLivreRequestInput): Promise<MlHttpResponse<T>> {
  const deps = input.deps ?? {}
  const config = deps.config ?? getMercadoLivreConfig()
  const store = deps.store ?? createSupabaseTokenStore()
  const refresh = (refreshToken: string) => refreshTokens({ config, refreshToken, fetchImpl: deps.fetchImpl })
  const tokenInput = {
    integrationId: input.integrationId,
    companyId: input.companyId,
    store,
    refresh,
    now: deps.now,
    sleep: deps.sleep,
    workerId: deps.workerId,
  }

  const send = (accessToken: string) => mlHttp<T>({
    baseUrl: config.apiBaseUrl,
    method: input.method,
    path: input.path,
    query: input.query,
    body: input.body,
    accessToken,
    timeoutMs: input.timeoutMs,
    fetchImpl: deps.fetchImpl,
    headers: input.headers,
  })

  const first = await getValidAccessToken(tokenInput)
  try {
    return await send(first.accessToken)
  } catch (err) {
    if (!(isMercadoLivreError(err) && err.kind === 'unauthorized')) {
      logApiError(input, err)
      throw err
    }
    if (first.refreshed) {
      // Acabou de renovar e mesmo assim 401 — não insiste.
      logApiError(input, err)
      throw err
    }
    const second = await getValidAccessToken({ ...tokenInput, forceIfExpiresAt: first.expiresAt ?? new Date(0) })
    try {
      return await send(second.accessToken)
    } catch (retryErr) {
      logApiError(input, retryErr)
      throw retryErr
    }
  }
}

function logApiError(input: MercadoLivreRequestInput, err: unknown): void {
  const e = isMercadoLivreError(err) ? err : new MercadoLivreError('network', 'erro inesperado')
  logMercadoLivre('mercadolivre.api.error', {
    company_id: input.companyId,
    integration_id: input.integrationId,
    http_status: e.httpStatus,
    request_id: e.requestId,
    reason: e.kind,
    path: input.path.split('?')[0],
  })
}
