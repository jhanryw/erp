import { describe, it, expect } from 'vitest'
import {
  isWholesaleHost,
  shouldRewriteToWholesaleApp,
  toInternalWholesalePath,
  resolveWholesaleBasePath,
  wholesaleHref,
  WHOLESALE_INTERNAL_PREFIX,
} from './site-host'

const HOST = 'atacado.santtorini.com'

describe('isWholesaleHost', () => {
  it('bate exatamente com o host configurado', () => {
    expect(isWholesaleHost('atacado.santtorini.com', HOST)).toBe(true)
  })

  it('case-insensitive', () => {
    expect(isWholesaleHost('Atacado.Santtorini.COM', HOST)).toBe(true)
  })

  it('host configurado sem porta ignora a porta do request (proxy/EasyPanel na frente)', () => {
    expect(isWholesaleHost('atacado.santtorini.com:443', HOST)).toBe(true)
  })

  it('host configurado COM porta exige porta igual — permite testar local sem hardcode de "localhost"', () => {
    expect(isWholesaleHost('atacado.localhost:3000', 'atacado.localhost:3000')).toBe(true)
    expect(isWholesaleHost('atacado.localhost:4000', 'atacado.localhost:3000')).toBe(false)
  })

  it('host diferente não bate', () => {
    expect(isWholesaleHost('santtorini.qarvon.com', HOST)).toBe(false)
  })

  it('localhost puro nunca bate sem configuração explícita — dev continua funcionando sem WHOLESALE_SITE_HOST', () => {
    expect(isWholesaleHost('localhost:3000', HOST)).toBe(false)
    expect(isWholesaleHost('localhost:3000', null)).toBe(false)
  })

  it('sem host configurado (env ausente) — nunca bate com nada', () => {
    expect(isWholesaleHost('atacado.santtorini.com', null)).toBe(false)
  })

  it('sem host de request — nunca bate', () => {
    expect(isWholesaleHost(null, HOST)).toBe(false)
    expect(isWholesaleHost(undefined, HOST)).toBe(false)
  })
})

describe('shouldRewriteToWholesaleApp', () => {
  it('páginas normais do site — sempre reescreve', () => {
    expect(shouldRewriteToWholesaleApp('/')).toBe(true)
    expect(shouldRewriteToWholesaleApp('/carrinho')).toBe(true)
    expect(shouldRewriteToWholesaleApp('/checkout')).toBe(true)
    expect(shouldRewriteToWholesaleApp('/produto/123')).toBe(true)
  })

  it('/api/** nunca é reescrito (inclui /api/wholesale/**)', () => {
    expect(shouldRewriteToWholesaleApp('/api/wholesale/produtos')).toBe(false)
    expect(shouldRewriteToWholesaleApp('/api/shipping/calculate')).toBe(false)
  })

  it('/_next nunca é reescrito', () => {
    expect(shouldRewriteToWholesaleApp('/_next/static/chunk.js')).toBe(false)
    expect(shouldRewriteToWholesaleApp('/_next/data/x.json')).toBe(false)
  })

  it('path já prefixado com /atacado não é reescrito de novo (evita /atacado/atacado)', () => {
    expect(shouldRewriteToWholesaleApp('/atacado')).toBe(false)
    expect(shouldRewriteToWholesaleApp('/atacado/carrinho')).toBe(false)
  })

  it('assets estáticos de public/ (com extensão) nunca são reescritos', () => {
    expect(shouldRewriteToWholesaleApp('/manifest.json')).toBe(false)
    expect(shouldRewriteToWholesaleApp('/sw.js')).toBe(false)
    expect(shouldRewriteToWholesaleApp('/robots.txt')).toBe(false)
    expect(shouldRewriteToWholesaleApp('/icons/icon-192.png')).toBe(false)
  })
})

describe('toInternalWholesalePath', () => {
  it('/ → /atacado', () => {
    expect(toInternalWholesalePath('/')).toBe('/atacado')
  })

  it('/carrinho → /atacado/carrinho', () => {
    expect(toInternalWholesalePath('/carrinho')).toBe('/atacado/carrinho')
  })

  it('/produto/123 → /atacado/produto/123 (rota correspondente, id preservado)', () => {
    expect(toInternalWholesalePath('/produto/123')).toBe('/atacado/produto/123')
  })

  it('/checkout → /atacado/checkout', () => {
    expect(toInternalWholesalePath('/checkout')).toBe('/atacado/checkout')
  })

  it('/dashboard → /atacado/dashboard (não existe como página real — bloqueio natural, sem lista de rotas administrativas pra manter)', () => {
    expect(toInternalWholesalePath('/dashboard')).toBe('/atacado/dashboard')
  })
})

describe('resolveWholesaleBasePath', () => {
  it("host de atacado (configurado) → basePath ''", () => {
    expect(resolveWholesaleBasePath('atacado.santtorini.com', HOST)).toBe('')
  })

  it('qualquer outro host (ERP, preview, localhost sem config) → basePath /atacado', () => {
    expect(resolveWholesaleBasePath('santtorini.qarvon.com', HOST)).toBe('/atacado')
    expect(resolveWholesaleBasePath('localhost:3000', HOST)).toBe('/atacado')
    expect(resolveWholesaleBasePath('localhost:3000', null)).toBe('/atacado')
  })
})

describe('wholesaleHref', () => {
  it("basePath '' (host de atacado) — link limpo, nunca /atacado", () => {
    expect(wholesaleHref('', '/')).toBe('/')
    expect(wholesaleHref('', '/carrinho')).toBe('/carrinho')
    expect(wholesaleHref('', '/produto/9')).toBe('/produto/9')
  })

  it('basePath /atacado (qualquer outro host) — mesmo comportamento de sempre', () => {
    expect(wholesaleHref(WHOLESALE_INTERNAL_PREFIX, '/')).toBe('/atacado')
    expect(wholesaleHref(WHOLESALE_INTERNAL_PREFIX, '/carrinho')).toBe('/atacado/carrinho')
  })

  it("path '' e '/' são equivalentes (home)", () => {
    expect(wholesaleHref('', '')).toBe('/')
    expect(wholesaleHref(WHOLESALE_INTERNAL_PREFIX, '')).toBe('/atacado')
  })
})
