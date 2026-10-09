import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { getWholesaleSiteSettings, getWholesaleCompanyLogoUrl } from '@/services/wholesale/settings'
import { getWholesaleCatalogPage, listWholesaleCategories } from '@/services/wholesale/catalog'
import { getActiveWholesaleBanners } from '@/services/wholesale/banners'
import { EMPTY_SITE_TEXTS, type WholesaleSiteTexts } from '@/services/wholesale/siteTexts'
import { CartProvider } from './_lib/CartContext'
import { WholesaleBasePathProvider } from './_lib/WholesaleBasePathContext'
import AtacadoLayout from './layout'
import AtacadoHomePage from './page'

vi.mock('@/lib/wholesale/tenant', () => ({ resolveWholesaleSiteTenant: vi.fn() }))
vi.mock('@/lib/wholesale/requestContext', () => ({ getWholesaleBasePath: () => '' }))
vi.mock('@/services/wholesale/settings', () => ({ getWholesaleSiteSettings: vi.fn(), getWholesaleCompanyLogoUrl: vi.fn() }))
vi.mock('@/services/wholesale/catalog', () => ({ getWholesaleCatalogPage: vi.fn(), listWholesaleCategories: vi.fn() }))
vi.mock('@/services/wholesale/banners', () => ({ getActiveWholesaleBanners: vi.fn() }))

const settings = (texts: Partial<WholesaleSiteTexts> = {}, over: Record<string, unknown> = {}) => ({
  catalogActive: true, displayName: 'Santtorini', whatsappPhone: null, minimumOrderAmount: 300,
  showOutOfStock: false, showStockQuantity: false, showSearch: true, showCategories: true, pixelEnabled: false, pixelId: null,
  texts: { ...EMPTY_SITE_TEXTS, ...texts }, ...over,
})

const category = { id: 1, slug: 'c', key: 'c', name: 'Calcinhas', imageUrl: null, imageAlt: null, imageSource: null, productCount: 1 }
const product = { productId: 1, name: 'Calcinha', brand: null, category: null, categorySlug: null, images: [], variations: [], priceFrom: 10, purchasable: true }

async function home(texts: Partial<WholesaleSiteTexts>, opts: { products?: unknown[]; search?: Record<string, string> } = {}) {
  ;(getWholesaleSiteSettings as any).mockResolvedValue(settings(texts))
  ;(getWholesaleCatalogPage as any).mockResolvedValue({ products: opts.products ?? [product], total: (opts.products ?? [product]).length, page: 1, pageSize: 24 })
  const el = await AtacadoHomePage({ searchParams: Promise.resolve(opts.search ?? {}) })
  return renderToStaticMarkup(<WholesaleBasePathProvider basePath=""><CartProvider>{el}</CartProvider></WholesaleBasePathProvider>)
}

async function layout(texts: Partial<WholesaleSiteTexts>) {
  ;(getWholesaleSiteSettings as any).mockResolvedValue(settings(texts))
  const el = await AtacadoLayout({ children: <p>conteúdo</p> })
  return renderToStaticMarkup(el)
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(resolveWholesaleSiteTenant as any).mockResolvedValue({ companyId: 1, systemUserId: 'u' })
  ;(getWholesaleCompanyLogoUrl as any).mockResolvedValue(null)
  ;(listWholesaleCategories as any).mockResolvedValue([category])
  ;(getActiveWholesaleBanners as any).mockResolvedValue([])
})

describe('exibição pública dos textos', () => {
  it('sem personalização: textos atuais (categorias, rodapé, vazio) e nenhum título extra', async () => {
    const html = await home({})
    expect(html).toContain('Nossas categorias')
    expect(html).not.toContain('<h1')
    expect(html).toContain('Compre por categoria')

    const empty = await home({}, { products: [], search: { q: 'renda' } })
    expect(empty).toContain('Nenhum produto encontrado para &quot;renda&quot;.')
    expect(await layout({})).toContain('Santtorini — vendas por atacado')
  })

  it('título/subtítulo da vitrine, título de categorias e de produtos personalizados', async () => {
    const html = await home({ heroTitle: 'Moda íntima no atacado', heroSubtitle: 'Peças selecionadas', categoriesTitle: 'Coleções', productsTitle: 'Todas as peças' })
    expect(html).toContain('<h1')
    expect(html).toContain('Moda íntima no atacado')
    expect(html).toContain('Peças selecionadas')
    expect(html).toContain('Coleções')
    expect(html).not.toContain('Nossas categorias')
    expect(html).toContain('Todas as peças')
  })

  it('hero e título de produtos só na home limpa (busca/filtro vão direto aos produtos)', async () => {
    const html = await home({ heroTitle: 'Hero', productsTitle: 'Prod' }, { search: { q: 'x' } })
    expect(html).not.toContain('Hero')
    expect(html).not.toContain('Prod<')
  })

  it('mensagem personalizada para lista vazia', async () => {
    expect(await home({ emptyMessage: 'Estamos reabastecendo!' }, { products: [] })).toContain('Estamos reabastecendo!')
  })

  it('rodapé institucional substitui o padrão e mantém as quebras de linha', async () => {
    const html = await layout({ footerText: 'Santtorini Moda Íntima\nAtendimento: seg a sex' })
    expect(html).toContain('Santtorini Moda Íntima')
    expect(html).toContain('Atendimento: seg a sex')
    expect(html).not.toContain('vendas por atacado')
    expect(html.match(/<p class="min-h-\[1em\]">/g)).toHaveLength(2)
  })
})

describe('proteção contra XSS — texto nunca vira HTML', () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>'

  it('todos os campos são escapados na vitrine e no rodapé', async () => {
    const texts = { heroTitle: evil, heroSubtitle: evil, categoriesTitle: evil, productsTitle: evil, emptyMessage: evil, footerText: evil }
    const html = await home(texts)
    const footer = await layout(texts)
    for (const out of [html, footer]) {
      expect(out).not.toContain('<script>')
      expect(out).not.toContain('<img src=x')
      expect(out).toContain('&lt;script&gt;')
    }
    expect(await home(texts, { products: [] })).not.toContain('<script>')
  })
})

describe('catálogo desativado', () => {
  it('layout continua escondendo o conteúdo, mesmo com textos personalizados', async () => {
    ;(getWholesaleSiteSettings as any).mockResolvedValue(settings({ footerText: 'Rodapé' }, { catalogActive: false }))
    const html = renderToStaticMarkup(await AtacadoLayout({ children: <p>SEGREDO</p> }))
    expect(html).not.toContain('SEGREDO')
  })
})
