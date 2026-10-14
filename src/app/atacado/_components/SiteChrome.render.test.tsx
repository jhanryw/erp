import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { SiteFooter, type SiteFooterProps } from './SiteFooter'
import { FloatingWhatsApp } from './FloatingWhatsApp'
import { DEFAULT_SITE_CHROME, resolveSiteChrome } from '@/services/wholesale/siteChrome'
import { buildWhatsAppContactUrl } from '@/lib/wholesale/whatsapp'

const emptyStore = { legalName: '', tradeName: '', cnpj: '', addressLine: '', city: '', state: '', mapsUrl: '' }
const base = (over: Partial<SiteFooterProps> = {}): SiteFooterProps => ({
  basePath: '', companyName: 'Santtorini', logoUrl: null, description: [], chrome: DEFAULT_SITE_CHROME,
  store: emptyStore, hasExplicitStoreName: false, whatsappUrl: null, year: 2026, ...over,
})
const html = (over: Partial<SiteFooterProps> = {}) => renderToStaticMarkup(<SiteFooter {...base(over)} />)

describe('SiteFooter — nada inventado, nada vazio', () => {
  it('sem nenhum dado: só navegação padrão e copyright (sem Atendimento, sem Nossa loja, sem marca vazia)', () => {
    const out = html()
    expect(out).toContain('Navegação')
    expect(out).toContain('© 2026 Santtorini. Todos os direitos reservados.')
    for (const title of ['Marca', 'Atendimento', 'Nossa loja']) expect(out).not.toContain(`>${title}<`)
    expect(out).not.toContain('CNPJ')
    expect(out).not.toMatch(/<(address|ul)[^>]*>\s*<\/(address|ul)>/)
  })

  it('navegação: padrões + links extras, na ordem cadastrada, com basePath', () => {
    const chrome = resolveSiteChrome({ footer: { navigationLinks: [{ label: 'Quem somos', url: '/quem-somos' }, { label: 'Blog', url: 'https://blog.exemplo.com' }] } })
    const out = html({ basePath: '/atacado', chrome })
    expect(out.indexOf('Início')).toBeLessThan(out.indexOf('Carrinho'))
    expect(out.indexOf('Carrinho')).toBeLessThan(out.indexOf('Quem somos'))
    expect(out.indexOf('Quem somos')).toBeLessThan(out.indexOf('Blog'))
    expect(out).toContain('href="/atacado/carrinho"')
    expect(out).toContain('href="https://blog.exemplo.com/"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  it('atendimento: WhatsApp (mesmo link do carrinho), Instagram, links e horário; some se tudo vazio', () => {
    const wa = buildWhatsAppContactUrl('84988887777', 'Olá!')
    const chrome = resolveSiteChrome({ social: { instagramUrl: 'https://instagram.com/santtorini' }, footer: { hours: 'Seg a sex, 9h às 18h', supportLinks: [{ label: 'Trocas', url: '/trocas' }] } })
    const out = html({ chrome, whatsappUrl: wa })
    expect(out).toContain('Atendimento')
    expect(out).toContain(`href="${wa}"`)
    expect(out).toContain('https://instagram.com/santtorini')
    expect(out).toContain('Seg a sex, 9h às 18h')
    expect(out).toContain('Trocas')
  })

  it('nossa loja: só campos preenchidos; CNPJ e endereço reais; Maps com noopener', () => {
    const out = html({
      store: { legalName: 'Santtorini Comércio LTDA', tradeName: 'Santtorini', cnpj: '11.222.333/0001-81', addressLine: 'Rua das Flores, 100', city: 'Natal', state: 'RN', mapsUrl: 'https://maps.google.com/?q=x' },
    })
    expect(out).toContain('Nossa loja')
    expect(out).toContain('CNPJ: 11.222.333/0001-81')
    expect(out).toContain('Rua das Flores, 100')
    expect(out).toContain('Natal / RN')
    expect(out).toContain('Ver no Google Maps')

    const partial = html({ store: { ...emptyStore, city: 'Natal' } })
    expect(partial).toContain('Natal')
    expect(partial).not.toContain('CNPJ')
    expect(partial).not.toContain('Google Maps')
  })

  it('seções desligadas no ERP não aparecem; copyright e links legais', () => {
    const chrome = resolveSiteChrome({
      footer: { sections: { navigation: false, legal: true }, legalLinks: [{ label: 'Privacidade', url: '/privacidade' }, { label: 'Termos', url: '/termos' }] },
    })
    const out = html({ chrome })
    expect(out).not.toContain('Navegação')
    expect(out.indexOf('Privacidade')).toBeLessThan(out.indexOf('Termos'))
    const noLegal = html({ chrome: resolveSiteChrome({ footer: { sections: { legal: false } } }) })
    expect(noLegal).not.toContain('Todos os direitos reservados')
  })

  it('marca: logo e descrição com quebras de linha; compacto (catálogo desativado) só copyright', () => {
    const out = html({ logoUrl: '/logo.png', description: ['Moda íntima por atacado', 'Natal/RN'] })
    expect(out).toContain('Moda íntima por atacado\nNatal/RN')
    expect(out).toContain('whitespace-pre-line')
    const compact = html({ logoUrl: '/logo.png', description: ['x'], compact: true })
    expect(compact).not.toContain('Navegação')
    expect(compact).toContain('Todos os direitos reservados')
  })

  it('XSS: todo texto é escapado', () => {
    const evil = '<script>alert(1)</script>'
    const out = html({ companyName: evil, description: [evil], store: { ...emptyStore, legalName: evil, addressLine: evil } })
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('sem rolagem horizontal por construção: grade responsiva dentro de max-w-6xl', () => {
    const out = html({ chrome: resolveSiteChrome({ social: { instagramUrl: 'https://instagram.com/x' } }), whatsappUrl: 'https://wa.me/5584988887777' })
    expect(out).toContain('sm:grid-cols-2')
    expect(out).toContain('max-w-6xl')
    expect(out).toContain('pb-24') // respiro para o botão flutuante no celular
    expect(out).toContain('lg:pb-20') // e no desktop (botão de 56px)
  })
})

describe('FloatingWhatsApp — glifo oficial, número do carrinho, safe areas', () => {
  const URL = 'https://wa.me/5584988887777?text=Ol%C3%A1!'

  it('link wa.me com o número normalizado e mensagem codificada; nova aba com noopener; nome acessível', () => {
    const out = renderToStaticMarkup(<FloatingWhatsApp url={URL} enabledDesktop enabledMobile />)
    expect(out).toContain(`href="${URL}"`)
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).toContain('aria-label="Falar com a loja no WhatsApp')
    expect(out).toContain('focus-visible:outline')
  })

  it('usa o SVG oficial LOCAL (sem URL externa), circular, canto inferior direito e safe areas', () => {
    const out = renderToStaticMarkup(<FloatingWhatsApp url={URL} enabledDesktop enabledMobile />)
    expect(out).toContain('src="/brand/whatsapp/whatsapp-glyph-white.svg"')
    expect(out).not.toMatch(/src="https?:/)
    expect(out).toContain('rounded-full')
    expect(out).toContain('env(safe-area-inset-bottom)')
    expect(out).toContain('env(safe-area-inset-right)')
    for (const file of ['whatsapp-glyph-white.svg', 'whatsapp-glyph-green.svg']) {
      const full = path.join(process.cwd(), 'public/brand/whatsapp', file)
      expect(existsSync(full)).toBe(true)
      const svg = readFileSync(full, 'utf8')
      expect(svg).toContain('<svg')
      expect(svg).not.toMatch(/<script|href=|onload/i)
    }
  })

  it('configuração de exibição: ambos desligados → nada; só desktop / só mobile → classes de visibilidade', () => {
    expect(renderToStaticMarkup(<FloatingWhatsApp url={URL} enabledDesktop={false} enabledMobile={false} />)).toBe('')
    const desktopOnly = renderToStaticMarkup(<FloatingWhatsApp url={URL} enabledDesktop enabledMobile={false} />)
    expect(desktopOnly).toContain('max-lg:hidden')
    expect(desktopOnly).not.toContain(' lg:hidden')
    const mobileOnly = renderToStaticMarkup(<FloatingWhatsApp url={URL} enabledDesktop={false} enabledMobile />)
    expect(mobileOnly).toContain('lg:hidden')
    expect(mobileOnly).not.toContain('max-lg:hidden')
  })
})
