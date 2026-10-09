const { buildSupabaseImagePatterns } = require('./config/supabase-image-patterns')

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  images: {
    // Derivado de NEXT_PUBLIC_SUPABASE_URL (build) — ver config/supabase-image-patterns.js.
    remotePatterns: buildSupabaseImagePatterns(process.env.NEXT_PUBLIC_SUPABASE_URL, {
      production: process.env.NODE_ENV === 'production',
    }),
    // Arquivos do Media Hub têm nome = UUID e nunca são sobrescritos (trocar a foto gera outro UUID), então o
    // resultado otimizado pode ficar em cache por 30 dias. O padrão do Next é 60 s: revalidava a cada minuto.
    minimumCacheTTL: 60 * 60 * 24 * 30,
    // Só tamanhos realmente usados pelo atacado (menos variantes = mais acertos de cache e menos CPU).
    deviceSizes: [360, 414, 640, 768, 1024, 1280, 1920],
    imageSizes: [64, 128, 256, 384],
  },
  experimental: {
    serverComponentsExternalPackages: [],
  },
  // Sem isso, o Service Worker pode ficar preso em cache por muito tempo em
  // produção (especialmente no Safari/PWA do iPhone), servindo uma versão
  // antiga sem os listeners de push mais recentes.
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        source: '/manifest.json',
        headers: [
          { key: 'Cache-Control', value: 'no-cache' },
        ],
      },
    ]
  },
}

module.exports = nextConfig
