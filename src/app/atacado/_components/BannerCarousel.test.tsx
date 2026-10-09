import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BannerCarousel, bannerHasText } from './BannerCarousel'
import { WholesaleBasePathProvider } from '../_lib/WholesaleBasePathContext'
import type { WholesaleBanner } from '@/services/wholesale/banners'

const base: WholesaleBanner = {
  id: 1, mediaPublicId: 'p', imageUrl: 'https://cdn.test/d.jpg', mobileImageUrl: null, altText: 'Alt',
  title: null, subtitle: null, ctaLabel: null, showText: true, isActive: true, sortOrder: 0, link: { type: 'none' },
}

const html = (banners: WholesaleBanner[]) =>
  renderToStaticMarkup(<WholesaleBasePathProvider basePath=""><BannerCarousel banners={banners} /></WholesaleBasePathProvider>)

describe('BannerCarousel', () => {
  it('banner só com imagem: sem textos, sem botão, sem link', () => {
    const out = html([base])
    expect(out).toContain('<img')
    expect(out).not.toContain('<h2')
    expect(out).not.toContain('<a ')
  })

  it('com textos e link: título, subtítulo e botão aparecem; slide inteiro é link', () => {
    const out = html([{ ...base, title: 'Verão', subtitle: 'Peças leves', ctaLabel: 'Ver coleção', link: { type: 'category', categorySlug: 'calcinhas' } }])
    expect(out).toContain('Verão')
    expect(out).toContain('Peças leves')
    expect(out).toContain('Ver coleção')
    expect(out).toContain('href="/?categoria=calcinhas"')
  })

  it('showText=false esconde os textos mesmo preenchidos (imagem já contém a mensagem)', () => {
    const b = { ...base, title: 'Verão', subtitle: 'x', ctaLabel: 'Ver', showText: false, link: { type: 'category', categorySlug: 'c' } as const }
    expect(bannerHasText(b)).toBe(false)
    const out = html([b])
    expect(out).not.toContain('Verão')
    expect(out).not.toContain('Ver<')
  })

  it('botão não aparece sem destino (não promete clique inexistente)', () => {
    const out = html([{ ...base, title: 'Sem link', ctaLabel: 'Clique', link: { type: 'none' } }])
    expect(out).toContain('Sem link')
    expect(out).not.toContain('Clique')
  })

  it('desktop + mobile: <picture> com source por breakpoint e proporção quadrada no celular', () => {
    const out = html([{ ...base, mobileImageUrl: 'https://cdn.test/m.jpg' }])
    expect(out).toContain('<picture>')
    expect(out).toContain('max-width: 639px')
    expect(out).toContain('min-width: 640px')
    expect(out).toContain('aspect-square')
    expect(out).toContain(encodeURIComponent('https://cdn.test/m.jpg'))
    expect(out).toContain(encodeURIComponent('https://cdn.test/d.jpg'))
  })

  it('sem imagem mobile: usa só a desktop, recortada em 16:9 no celular', () => {
    const out = html([base])
    expect(out).toContain('aspect-[16/9]')
    expect(out).not.toContain('max-width: 639px')
  })
})
