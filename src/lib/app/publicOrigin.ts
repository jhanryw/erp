/**
 * Origem PÚBLICA/canônica do Qarvon (ex.: https://santtorini.qarvon.com)
 * para redirects gerados no servidor.
 *
 * Nunca usar request.url / nextUrl.origin / Host: atrás do proxy do
 * EasyPanel o Next recebe a requisição como http://<id-do-container>:80,
 * e um redirect montado a partir disso manda o navegador para um host
 * interno inexistente.
 *
 * Ordem:
 *   1. APP_URL (server-only, lida em RUNTIME — NEXT_PUBLIC_* é embutida no
 *      build e não é configurada no build de produção);
 *   2. origem de MERCADOLIVRE_REDIRECT_URI (já é a URL pública cadastrada
 *      no DevCenter);
 *   3. null → o chamador usa Location RELATIVO (o navegador resolve contra
 *      a URL pública que ele mesmo está usando).
 */
export function getPublicAppOrigin(env: Record<string, string | undefined> = process.env): string | null {
  for (const raw of [env.APP_URL, env.MERCADOLIVRE_REDIRECT_URI]) {
    const value = raw?.trim()
    if (!value) continue
    try {
      const url = new URL(value)
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin
    } catch {
      // valor inválido: tenta o próximo
    }
  }
  return null
}

/** URL absoluta canônica para `path` (com query), ou o próprio `path` relativo se não houver origem configurada. */
export function publicAppUrl(path: string, env?: Record<string, string | undefined>): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('publicAppUrl: path precisa ser absoluto no app (começar com uma única "/").')
  const origin = getPublicAppOrigin(env)
  return origin ? new URL(path, origin).toString() : path
}
