/**
 * Erros tipados do Mercado Livre. Nunca carregam segredo: mensagens vindas
 * da API passam por `redactSecrets` antes de virar `message`.
 */

export type MercadoLivreErrorKind =
  | 'config'            // CLIENT_ID/SECRET/REDIRECT_URI ausentes
  | 'invalid_state'     // state OAuth inválido/expirado/já usado/de outro usuário
  | 'oauth_denied'      // usuário negou no Mercado Livre (callback com error=)
  | 'reauth_required'   // invalid_grant / refresh revogado → exige novo OAuth
  | 'integration_disabled'
  | 'integration_not_found'
  | 'refresh_in_progress'
  | 'account_conflict'  // conta ML já conectada em outra empresa
  | 'unauthorized'      // 401 da API mesmo após refresh
  | 'forbidden'         // 403
  | 'not_found'         // 404
  | 'bad_request'       // 400/422
  | 'rate_limited'      // 429
  | 'server'            // 5xx
  | 'timeout'
  | 'network'

const RETRYABLE: ReadonlySet<MercadoLivreErrorKind> = new Set(['rate_limited', 'server', 'timeout', 'network', 'refresh_in_progress'])

export class MercadoLivreError extends Error {
  readonly kind: MercadoLivreErrorKind
  readonly httpStatus: number | null
  /** Código de erro do Mercado Livre (`error`), ex.: invalid_grant. */
  readonly mlError: string | null
  readonly retryAfterSeconds: number | null
  readonly requestId: string | null

  constructor(
    kind: MercadoLivreErrorKind,
    message: string,
    opts: { httpStatus?: number | null; mlError?: string | null; retryAfterSeconds?: number | null; requestId?: string | null } = {},
  ) {
    super(redactSecrets(message))
    this.name = 'MercadoLivreError'
    this.kind = kind
    this.httpStatus = opts.httpStatus ?? null
    this.mlError = opts.mlError ?? null
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null
    this.requestId = opts.requestId ?? null
  }

  /** Falha transitória — o chamador (fila futura) pode tentar de novo depois. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind)
  }
}

/**
 * Remove qualquer coisa com cara de credencial do Mercado Livre de um texto
 * (access tokens `APP_USR-…`, refresh tokens/códigos `TG-…`, Bearer, e
 * pares chave=valor sensíveis).
 */
export function redactSecrets(text: string): string {
  return String(text ?? '')
    .replace(/APP_USR-[A-Za-z0-9-]+/g, 'APP_USR-[REDACTED]')
    .replace(/\bTG-[A-Za-z0-9-]+/g, 'TG-[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|client_secret|code|code_verifier)\s*[=:]\s*"?)[^"&\s,}]+/gi, '$1[REDACTED]')
}

export function isMercadoLivreError(err: unknown): err is MercadoLivreError {
  return err instanceof MercadoLivreError
}
