import { describe, it, expect, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CategoryGrid, categoryCardHref } from './CategoryGrid'
import type { WholesaleCategory } from '@/services/wholesale/catalog'

const cat = (over: Partial<WholesaleCategory>): WholesaleCategory => ({
  id: 1, slug: 'calcinhas', name: 'Calcinhas', key: 'calcinhas', imageUrl: null, imageAlt: null, imageSource: null, productCount: 3, ...over,
})

beforeEach(() => { process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.test' })

const STORAGE = 'https://supabase.test/storage/v1/object/public/media-public/1/capa.jpg'

describe('CategoryGrid', () => {
  it('não renderiza nada sem categorias', () => {
    expect(renderToStaticMarkup(<CategoryGrid categories={[]} basePath="" />)).toBe('')
  })

  it('card com capa: foto otimizada, nome e link para a categoria + âncora da lista', () => {
    const out = renderToStaticMarkup(<CategoryGrid basePath="" categories={[cat({ imageUrl: STORAGE, imageSource: 'cover', imageAlt: 'Capa' })]} />)
    expect(out).toContain('Calcinhas')
    expect(out).toContain('href="/?categoria=calcinhas#produtos"')
    expect(out).toContain(encodeURIComponent(STORAGE)) // passa pelo otimizador /_next/image
    expect(out).toContain('alt="Capa"')
  })

  it('foto vinda de produto usa <img> nativo (URL pode ser externa)', () => {
    const out = renderToStaticMarkup(<CategoryGrid basePath="" categories={[cat({ imageUrl: 'https://outro-host.test/p.jpg', imageSource: 'product' })]} />)
    expect(out).toContain('src="https://outro-host.test/p.jpg"')
    expect(out).not.toContain('/_next/image')
  })

  it('sem imagem: card tipográfico, sem <img>', () => {
    const out = renderToStaticMarkup(<CategoryGrid basePath="" categories={[cat({})]} />)
    expect(out).toContain('Calcinhas')
    expect(out).not.toContain('<img')
  })

  it('categorias de slug repetido geram links distintos (chave slug~id) e respeitam o basePath', () => {
    const out = renderToStaticMarkup(
      <CategoryGrid basePath="/atacado" categories={[cat({ id: 2, key: 'camisetas~2', name: 'Fem' }), cat({ id: 3, key: 'camisetas~3', name: 'Masc' })]} />,
    )
    expect(out).toContain('href="/atacado?categoria=camisetas~2#produtos"')
    expect(out).toContain('href="/atacado?categoria=camisetas~3#produtos"')
    expect(categoryCardHref('', { key: 'a b' })).toBe('/?categoria=a%20b#produtos')
  })

  it('grade responsiva: 2 colunas no celular, 3 no tablet, 4 no desktop', () => {
    const out = renderToStaticMarkup(<CategoryGrid basePath="" categories={[cat({})]} />)
    expect(out).toContain('grid-cols-2')
    expect(out).toContain('sm:grid-cols-3')
    expect(out).toContain('lg:grid-cols-4')
  })
})
