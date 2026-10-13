import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BannerCarousel, bannerHasText, bannerRatios } from './BannerCarousel'
import { WholesaleBasePathProvider } from '../_lib/WholesaleBasePathContext'
import type { WholesaleBanner } from '@/services/wholesale/banners'

const base: WholesaleBanner = {
  id: 1, mediaPublicId: 'p', imageUrl: 'https://cdn.test/d.jpg', mobileImageUrl: null, imageWidth: 1920, imageHeight: 640, mobileImageWidth: null, mobileImageHeight: null, altText: 'Alt',
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

  it('desktop + mobile: <picture> com source por breakpoint (só uma é baixada)', () => {
    const out = html([{ ...base, mobileImageUrl: 'https://cdn.test/m.jpg', mobileImageWidth: 1080, mobileImageHeight: 1350 }])
    expect(out).toContain('<picture>')
    expect(out).toContain('max-width: 639px')
    expect(out).toContain(encodeURIComponent('https://cdn.test/m.jpg'))
    expect(out).toContain(encodeURIComponent('https://cdn.test/d.jpg'))
  })

  it('contêiner acompanha a proporção REAL da arte: variáveis CSS, sem proporção fixa e sem fundo cinza', () => {
    const out = html([{ ...base, mobileImageUrl: 'https://cdn.test/m.jpg', mobileImageWidth: 1080, mobileImageHeight: 1350 }])
    expect(out).toContain('--banner-ar-m:1080 / 1350')
    expect(out).toContain('--banner-ar-d:1920 / 640')
    expect(out).toContain('aspect-[var(--banner-ar-m)]')
    expect(out).toContain('sm:aspect-[var(--banner-ar-d)]')
    expect(out).not.toContain('aspect-[3/1]')
    expect(out).not.toContain('aspect-square')
    expect(out).not.toContain('bg-stone-100')
    expect(out).not.toContain('bg-gray')
  })

  it('sem imagem mobile: a arte desktop inteira, na proporção ORIGINAL, também no celular', () => {
    expect(bannerRatios(base)).toEqual({ desktop: '1920 / 640', mobile: '1920 / 640' })
    expect(bannerRatios({ ...base, imageWidth: 1600, imageHeight: 900 })).toEqual({ desktop: '1600 / 900', mobile: '1600 / 900' })
    const out = html([base])
    expect(out).toContain('--banner-ar-m:1920 / 640')
    expect(out).not.toContain('max-width: 639px')
  })

  it('imagem mobile quadrada ou vertical usa as dimensões dela, sem recorte automático', () => {
    expect(bannerRatios({ ...base, mobileImageUrl: 'u', mobileImageWidth: 1080, mobileImageHeight: 1080 }).mobile).toBe('1080 / 1080')
    expect(bannerRatios({ ...base, mobileImageUrl: 'u', mobileImageWidth: 800, mobileImageHeight: 1200 }).mobile).toBe('800 / 1200')
  })

  it('dimensões ilegíveis: reserva 3:1 no desktop e quadrada para a mobile cadastrada', () => {
    const noDims = { ...base, imageWidth: null, imageHeight: null }
    expect(bannerRatios(noDims).desktop).toBe('3 / 1')
    expect(bannerRatios({ ...noDims, mobileImageUrl: 'u' }).mobile).toBe('1 / 1')
  })

  it('arte com texto nunca recorta (contain); foto de fundo com texto do site usa cover e 16:9 no celular', () => {
    expect(html([base])).toContain('object-contain')
    expect(html([base])).not.toContain('object-cover')

    const photo = { ...base, title: 'Verão', link: { type: 'category', categorySlug: 'c' } as const }
    const out = html([photo])
    expect(out).toContain('object-cover')
    expect(bannerRatios(photo)).toEqual({ desktop: '1920 / 640', mobile: '16 / 9' })
  })

  it('sem imagem mobile a <img> mantém o srcSet responsivo (não baixa a maior largura no celular)', () => {
    const out = html([base])
    const srcSet = /srcSet="([^"]+)"/.exec(out)?.[1] ?? ''
    expect(srcSet.split(',').length).toBeGreaterThan(2) // várias larguras para o navegador escolher
    expect(out).toContain('sizes="(min-width: 1184px) 1152px, 100vw"')
  })

  it('primeiro banner tem prioridade (eager + fetchPriority high); só o breakpoint corrente é baixado (picture)', () => {
    const out = html([base, { ...base, id: 2 }])
    expect(out).toContain('loading="eager"')
    expect(out).toContain('fetchPriority="high"')
    expect(out.match(/<picture>/g)).toHaveLength(1) // carrossel renderiza só o slide atual
  })
})
