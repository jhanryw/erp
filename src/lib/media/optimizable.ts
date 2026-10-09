import { buildSupabaseImagePatterns } from '../../../config/supabase-image-patterns'

interface Pattern { protocol?: string; hostname: string; port?: string; pathname?: string }

let cachedFor: string | undefined
let cachedPatterns: Pattern[] = []

function patterns(): Pattern[] {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (cachedFor !== url || cachedPatterns.length === 0) {
    cachedFor = url
    cachedPatterns = buildSupabaseImagePatterns(url) as Pattern[]
  }
  return cachedPatterns
}

/** Glob mínimo do Next: `*.dominio` e `**` no fim do caminho. */
function hostMatches(pattern: string, host: string): boolean {
  return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : pattern === host
}

/**
 * A URL pode passar pelo otimizador `/_next/image`? Só as do bucket público do Supabase (a MESMA allowlist do
 * next.config.js). URLs externas (`media.external_url`) continuam como `<img>` — o `next/image` lançaria erro
 * para host fora da lista e derrubaria a página.
 */
export function isOptimizableImageUrl(src: string | null | undefined): boolean {
  if (!src) return false
  let url: URL
  try { url = new URL(src) } catch { return false }
  return patterns().some((p) => {
    if (p.protocol && p.protocol !== url.protocol.slice(0, -1)) return false
    if (p.port !== undefined && p.port !== url.port) return false
    if (!hostMatches(p.hostname, url.hostname)) return false
    const prefix = (p.pathname ?? '/**').replace(/\*\*$/, '')
    return url.pathname.startsWith(prefix)
  })
}
