import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
// Matcher REAL do Next (o mesmo que /_next/image usa para aceitar ou rejeitar a URL).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { hasRemoteMatch } = require('next/dist/shared/lib/match-remote-pattern') as {
  hasRemoteMatch: (domains: string[], patterns: any[], url: URL) => boolean
}
import { buildSupabaseImagePatterns } from './supabase-image-patterns'

const PROD_URL = 'https://supabase.santtorini.qarvon.com'
const objectUrl = (base: string, bucket = 'media-public', key = '1/abc.jpg') =>
  new URL(`${base}/storage/v1/object/public/${bucket}/${key}`)

// Configuração ANTERIOR do next.config.js (reprodução do bug).
const LEGACY_PATTERNS = [
  { protocol: 'https', hostname: '*.supabase.co', pathname: '/storage/v1/object/public/**' },
  { protocol: 'http', hostname: 'localhost' },
]

const accepts = (patterns: any[], url: URL) => hasRemoteMatch([], patterns, url)

describe('reprodução do bug: configuração anterior rejeita o Supabase self-hosted', () => {
  it('rejeita a URL pública do domínio de produção (logo/banners/fotos no ERP quebravam)', () => {
    expect(accepts(LEGACY_PATTERNS, objectUrl(PROD_URL))).toBe(false)
  })
  it('só aceitava localhost (por isso nada quebrava em dev)', () => {
    expect(accepts(LEGACY_PATTERNS, objectUrl('http://localhost:8000'))).toBe(true)
  })
})

describe('buildSupabaseImagePatterns', () => {
  const patterns = buildSupabaseImagePatterns(PROD_URL, { production: true })

  it('aceita o bucket público do domínio de produção', () => {
    expect(accepts(patterns, objectUrl(PROD_URL))).toBe(true)
  })

  it('mantém compatibilidade com Supabase Cloud', () => {
    expect(accepts(patterns, objectUrl('https://abcd.supabase.co'))).toBe(true)
  })

  it('restringe o protocolo (http no host de produção é rejeitado)', () => {
    expect(accepts(patterns, objectUrl('http://supabase.santtorini.qarvon.com'))).toBe(false)
  })

  it('restringe o host (outro domínio é rejeitado)', () => {
    expect(accepts(patterns, objectUrl('https://evil.example.com'))).toBe(false)
    expect(accepts(patterns, objectUrl('https://supabase.santtorini.qarvon.com.evil.com'))).toBe(false)
  })

  it('restringe o caminho ao bucket público de catálogo', () => {
    expect(accepts(patterns, objectUrl(PROD_URL, 'media-private'))).toBe(false)
    expect(accepts(patterns, new URL(`${PROD_URL}/rest/v1/media`))).toBe(false)
    expect(accepts(patterns, new URL(`${PROD_URL}/storage/v1/object/sign/media-public/1/a.jpg?token=x`))).toBe(false)
  })

  it('respeita porta explícita e prefixo de caminho', () => {
    const p = buildSupabaseImagePatterns('http://localhost:8000/supabase')
    expect(accepts(p, objectUrl('http://localhost:8000/supabase'))).toBe(true)
    expect(accepts(p, objectUrl('http://localhost:9999/supabase'))).toBe(false)
    expect(accepts(p, objectUrl('http://localhost:8000'))).toBe(false)
  })

  it('em produção sem a variável: avisa no build e só mantém Supabase Cloud', () => {
    const warn = vi_spyWarn()
    const p = buildSupabaseImagePatterns(undefined, { production: true })
    expect(warn.calls).toBe(1)
    expect(accepts(p, objectUrl(PROD_URL))).toBe(false)
    warn.restore()
  })

  it('URL inválida não lança', () => {
    expect(() => buildSupabaseImagePatterns('nao-e-url')).not.toThrow()
  })
})

describe('next.config.js real', () => {
  it('usa NEXT_PUBLIC_SUPABASE_URL do ambiente de build', () => {
    const require_ = createRequire(import.meta.url)
    const path = require_.resolve('../next.config.js')
    const previous = process.env.NEXT_PUBLIC_SUPABASE_URL
    try {
      process.env.NEXT_PUBLIC_SUPABASE_URL = PROD_URL
      delete require_.cache[path]
      const cfg = require_(path)
      expect(accepts(cfg.images.remotePatterns, objectUrl(PROD_URL))).toBe(true)
      expect(accepts(cfg.images.remotePatterns, objectUrl('https://evil.example.com'))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
      else process.env.NEXT_PUBLIC_SUPABASE_URL = previous
      delete require_.cache[path]
    }
  })
})

function vi_spyWarn() {
  const original = console.warn
  const state = { calls: 0, restore: () => { console.warn = original } }
  console.warn = () => { state.calls++ }
  return state
}
