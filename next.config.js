const { buildSupabaseImagePatterns } = require('./config/supabase-image-patterns')

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  images: {
    // Derivado de NEXT_PUBLIC_SUPABASE_URL (build) — ver config/supabase-image-patterns.js.
    remotePatterns: buildSupabaseImagePatterns(process.env.NEXT_PUBLIC_SUPABASE_URL, {
      production: process.env.NODE_ENV === 'production',
    }),
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
