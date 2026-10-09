// Allowlist do `next/image` para as mídias públicas do Supabase Storage.
//
// Vive em CommonJS puro porque `next.config.js` precisa dar `require` nele
// (avaliado no `next build`) e os testes importam o MESMO módulo — a lista
// testada é exatamente a lista usada em produção.
//
// O host vem de NEXT_PUBLIC_SUPABASE_URL, a mesma variável que
// `getPublicUrl()` usa para montar a URL da imagem — assim as duas pontas
// nunca divergem (causa raiz do logo/banners quebrados em produção, com o
// Supabase self-hosted fora de *.supabase.co).
//
// Restrição: protocolo + host + porta + caminho do bucket público de
// catálogo. Nenhum outro bucket nem o resto do host passam pelo otimizador.

const PUBLIC_BUCKET = 'media-public'
const STORAGE_PUBLIC_PATH = '/storage/v1/object/public'

function trimSlashes(path) {
  return path.replace(/^\/+|\/+$/g, '')
}

/**
 * @param {string | undefined} supabaseUrl valor de NEXT_PUBLIC_SUPABASE_URL
 * @param {{ production?: boolean }} [options]
 * @returns {import('next/dist/shared/lib/image-config').RemotePattern[]}
 */
function buildSupabaseImagePatterns(supabaseUrl, options = {}) {
  const patterns = []

  // Supabase Cloud (compatibilidade com a configuração anterior), agora
  // restrito ao bucket de catálogo.
  patterns.push({
    protocol: 'https',
    hostname: '*.supabase.co',
    pathname: `${STORAGE_PUBLIC_PATH}/${PUBLIC_BUCKET}/**`,
  })

  let parsed = null
  try {
    parsed = supabaseUrl ? new URL(supabaseUrl) : null
  } catch {
    parsed = null
  }

  if (parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:')) {
    // Suporta Supabase atrás de um prefixo de caminho (ex.: https://host/supabase).
    const prefix = trimSlashes(parsed.pathname)
    const basePath = prefix ? `/${prefix}` : ''
    patterns.push({
      protocol: parsed.protocol.slice(0, -1),
      hostname: parsed.hostname,
      ...(parsed.port ? { port: parsed.port } : {}),
      pathname: `${basePath}${STORAGE_PUBLIC_PATH}/${PUBLIC_BUCKET}/**`,
    })
  } else if (options.production) {
    // Não derruba o build, mas deixa o motivo explícito: sem o host, toda
    // imagem via next/image quebra em produção.
    console.warn(
      '[next.config] NEXT_PUBLIC_SUPABASE_URL ausente ou inválida durante o build — ' +
        'imagens do Supabase Storage via next/image serão rejeitadas. ' +
        'Informe o build-arg NEXT_PUBLIC_SUPABASE_URL no build da imagem Docker.',
    )
  }

  return patterns
}

module.exports = { buildSupabaseImagePatterns, PUBLIC_BUCKET, STORAGE_PUBLIC_PATH }
