/**
 * Erros tipados da Shopee Open Platform. Nunca carregam segredo: toda
 * mensagem passa por `redactSecrets` antes de virar `message`, e nenhuma
 * mensagem é montada com partner_key, tokens, `sign` ou query string (a
 * Shop API da Shopee leva access_token NA QUERY — por isso as mensagens só
 * citam o pathname).
 */

export type ShopeeErrorKind =
  | 'config'               // PARTNER_ID/PARTNER_KEY/REDIRECT_URI ausentes ou inválidos
  | 'invalid_state'        // state OAuth inválido/expirado/já usado/de outra empresa ou usuário
  | 'invalid_callback'     // callback sem code/shop_id ou com shop_id malformado
  | 'oauth_denied'         // vendedor recusou/cancelou a autorização
  | 'reauth_required'      // refresh_token inválido/expirado/já usado → exige novo OAuth
  | 'integration_disabled'
  | 'integration_not_found'
  | 'refresh_in_progress'
  | 'account_conflict'     // loja já conectada em outra empresa
  | 'unauthorized'         // autenticação recusada (token/assinatura)
  | 'forbidden'            // autorização recusada (sem permissão para o recurso)
  | 'bad_request'          // validação de parâmetros
  | 'rate_limited'         // 429
  | 'server'               // 5xx
  | 'timeout'
  | 'network'
  | 'invalid_response'     // resposta sem os campos esperados / não-JSON

const RETRYABLE: ReadonlySet<ShopeeErrorKind> = new Set(['rate_limited', 'server', 'timeout', 'network', 'refresh_in_progress'])

export class ShopeeError extends Error {
  readonly kind: ShopeeErrorKind
  readonly httpStatus: number | null
  /** Código `error` devolvido pela Shopee (ex.: error_auth, error_param). */
  readonly shopeeError: string | null
  readonly requestId: string | null
  readonly retryAfterSeconds: number | null

  constructor(
    kind: ShopeeErrorKind,
    message: string,
    opts: { httpStatus?: number | null; shopeeError?: string | null; requestId?: string | null; retryAfterSeconds?: number | null } = {},
  ) {
    super(redactSecrets(message))
    this.name = 'ShopeeError'
    this.kind = kind
    this.httpStatus = opts.httpStatus ?? null
    this.shopeeError = opts.shopeeError ?? null
    this.requestId = opts.requestId ?? null
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null
  }

  /** Falha transitória — a camada chamadora pode tentar de novo depois. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind)
  }
}

export function isShopeeError(err: unknown): err is ShopeeError {
  return err instanceof ShopeeError
}

/** Remove pares chave=valor sensíveis e Bearer de um texto livre. */
export function redactSecrets(text: string): string {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|partner_key|sign|code)"?\s*[=:]\s*"?)[^"&\s,}]+/gi, '$1[REDACTED]')
}
