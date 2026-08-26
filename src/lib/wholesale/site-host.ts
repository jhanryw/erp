/**
 * Domínio próprio do site de atacado (`atacado.santtorini.com`) — módulo
 * PURO (sem `next/headers`, sem I/O), pra ser testável sem mock de
 * request/response. Único lugar que sabe o nome da variável de ambiente
 * `WHOLESALE_SITE_HOST` — nenhum outro arquivo deve ler
 * `process.env.WHOLESALE_SITE_HOST` diretamente nem espalhar o domínio
 * pelo código (ver middleware.ts e src/lib/wholesale/requestContext.ts).
 *
 * O mesmo container Next.js serve dois hosts:
 *   santtorini.qarvon.com     → ERP administrativo (comportamento atual, inalterado)
 *   atacado.santtorini.com    → site de atacado, com rewrite pra /atacado
 * Continua funcionando em localhost/dev: sem WHOLESALE_SITE_HOST
 * configurada, isWholesaleHost() sempre devolve false — nenhum rewrite
 * acontece, `/atacado/**` continua acessível do jeito que já era.
 */

/** Prefixo interno real das páginas do site de atacado — nunca exposto na URL pública quando o rewrite por host está ativo. */
export const WHOLESALE_INTERNAL_PREFIX = '/atacado'

/** Lê e normaliza `WHOLESALE_SITE_HOST` (lowercase, sem espaços). `null` quando não configurada. */
export function getWholesaleSiteHost(): string | null {
  const raw = process.env.WHOLESALE_SITE_HOST?.trim()
  return raw ? raw.toLowerCase() : null
}

/**
 * `true` quando `requestHost` (o header `Host` da requisição, pode incluir
 * porta — ex. `localhost:3000`) corresponde ao host configurado do site de
 * atacado. Se `WHOLESALE_SITE_HOST` não tiver porta (caso normal em
 * produção, ex. `atacado.santtorini.com`), a porta do request é ignorada
 * na comparação — permite configurar `WHOLESALE_SITE_HOST=atacado.
 * localhost` pra testar localmente em qualquer porta, sem hardcode de
 * porta nem de "localhost" em nenhum lugar do código.
 *
 * `configuredHost` é injetável só para teste — produção sempre usa o
 * valor default (lido de `getWholesaleSiteHost()`).
 */
export function isWholesaleHost(
  requestHost: string | null | undefined,
  configuredHost: string | null = getWholesaleSiteHost(),
): boolean {
  if (!configuredHost || !requestHost) return false
  const normalizedRequestHost = configuredHost.includes(':')
    ? requestHost.toLowerCase()
    : requestHost.toLowerCase().split(':')[0]
  return normalizedRequestHost === configuredHost
}

/**
 * `true` quando este pathname (do host de atacado) deve ser reescrito para
 * `/atacado/**` internamente. Exclui:
 *   - `/api/**` — nunca prefixado, as rotas `/api/wholesale/**` já são o
 *     caminho real;
 *   - `/_next` — defesa extra além do `matcher` do middleware, que já
 *     exclui estáticos/imagens/favicon antes de a função rodar;
 *   - qualquer path já prefixado com `/atacado` — evita duplicar
 *     (`/atacado/atacado/...`) se alguém acessar a URL "por dentro"
 *     diretamente no host de atacado;
 *   - qualquer path com "cara de arquivo estático" (último segmento com
 *     extensão — `manifest.json`, `sw.js`, `robots.txt`, ícones, etc. em
 *     `public/`) — evita precisar enumerar cada asset da pasta `public/`
 *     manualmente; nenhuma rota de página deste projeto tem `.` no último
 *     segmento.
 */
export function shouldRewriteToWholesaleApp(pathname: string): boolean {
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1)
  const looksLikeStaticFile = lastSegment.includes('.')

  return (
    !pathname.startsWith('/api/') &&
    !pathname.startsWith('/_next') &&
    !pathname.startsWith(WHOLESALE_INTERNAL_PREFIX) &&
    !looksLikeStaticFile
  )
}

/** `/` → `/atacado`; `/carrinho` → `/atacado/carrinho`; etc. Só a query/hash é preservada automaticamente por quem clona a URL (ver middleware.ts) — esta função só toca o pathname. */
export function toInternalWholesalePath(pathname: string): string {
  return pathname === '/' ? WHOLESALE_INTERNAL_PREFIX : `${WHOLESALE_INTERNAL_PREFIX}${pathname}`
}

/**
 * Base path pra construir links/redirects DENTRO do app de atacado:
 * `''` quando a requisição atual já está no host de atacado (rewrite
 * ativo, URL pública limpa — nunca adicionar `/atacado` de novo);
 * `/atacado` em qualquer outro host (ERP administrativo, preview, dev sem
 * `WHOLESALE_SITE_HOST` configurada) — mesmo comportamento de sempre.
 */
export function resolveWholesaleBasePath(
  requestHost: string | null | undefined,
  configuredHost: string | null = getWholesaleSiteHost(),
): string {
  return isWholesaleHost(requestHost, configuredHost) ? '' : WHOLESALE_INTERNAL_PREFIX
}

/**
 * Monta um href interno do site de atacado a partir de um `basePath`
 * (`''` ou `/atacado`, ver `resolveWholesaleBasePath`) e um path
 * relativo à raiz do app (`''`/`'/'` para a home, `/carrinho`,
 * `/produto/123`, etc.). Único ponto que decide como um link vira string
 * — usado por todo componente/página do site de atacado em vez de
 * concatenar `/atacado` manualmente.
 */
export function wholesaleHref(basePath: string, path: string): string {
  if (path === '' || path === '/') return basePath || '/'
  return `${basePath}${path}`
}
