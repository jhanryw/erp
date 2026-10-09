import type { Metadata } from 'next'
import Link from 'next/link'
import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { getWholesaleCatalogPage, listWholesaleCategories } from '@/services/wholesale/catalog'
import { getActiveWholesaleBanners } from '@/services/wholesale/banners'
import { getWholesaleSiteSettings } from '@/services/wholesale/settings'
import { ProductCard } from './_components/ProductCard'
import { CategoryMobileButton, CategorySidebar } from './_components/CategoryNav'
import { BannerCarousel } from './_components/BannerCarousel'
import { CategoryGrid } from './_components/CategoryGrid'
import { getWholesaleBasePath } from '@/lib/wholesale/requestContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'
import { resolveSiteTexts } from '@/services/wholesale/siteTexts'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

export const metadata: Metadata = {
  title: 'Catálogo',
  description: 'Catálogo de atacado — preços e disponibilidade em tempo real.',
}

type SearchParams = Promise<{ q?: string; categoria?: string; page?: string }>

export default async function AtacadoHomePage({ searchParams }: { searchParams: SearchParams }) {
  const { q, categoria, page } = await searchParams
  const tenant = await resolveWholesaleSiteTenant()
  const basePath = getWholesaleBasePath()

  if (!tenant) {
    return (
      <div className="py-20 text-center">
        <p className="text-gray-500">Catálogo ainda não configurado. Volte em breve.</p>
      </div>
    )
  }

  // catalog_active é o controle mestre — o layout já esconde o conteúdo, mas
  // a página também não busca nenhum dado quando o catálogo está desativado.
  const settings = await getWholesaleSiteSettings(tenant.companyId)
  if (!settings.catalogActive) return null

  const texts = resolveSiteTexts(settings.texts, settings.displayName)
  const pageNumber = Math.max(1, Number(page ?? '1') || 1)
  // Vitrine de entrada (banner + cards) só na home "limpa"; ao buscar, filtrar ou paginar o cliente vai direto aos produtos.
  const isFiltered = !!q || !!categoria || pageNumber > 1
  const [result, categories, banners] = await Promise.all([
    getWholesaleCatalogPage(tenant.companyId, { search: q, categorySlug: categoria, page: pageNumber }),
    listWholesaleCategories(tenant.companyId, { withImages: !isFiltered && settings.showCategories }),
    getActiveWholesaleBanners(tenant.companyId),
  ])
  const activeCategory = categoria ? categories.find((c) => c.key === categoria) ?? null : null
  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize))

  return (
    <div className="space-y-8 sm:space-y-10">
      {!isFiltered && (texts.heroTitle || texts.heroSubtitle) && (
        <div className="space-y-1.5 text-center sm:text-left">
          {texts.heroTitle && <h1 className="font-serif text-3xl leading-tight text-gray-900 sm:text-4xl">{texts.heroTitle}</h1>}
          {texts.heroSubtitle && <p className="text-sm text-gray-600 sm:text-base">{texts.heroSubtitle}</p>}
        </div>
      )}

      {!isFiltered && banners.length > 0 && <BannerCarousel banners={banners} />}

      {!isFiltered && settings.showCategories && <CategoryGrid categories={categories} basePath={basePath} title={texts.categoriesTitle} eagerCount={banners.length > 0 ? 0 : 2} />}

      <section id="produtos" className="scroll-mt-24 space-y-5">
        {!isFiltered && texts.productsTitle && (
          <h2 className="font-serif text-2xl text-gray-900 sm:text-3xl">{texts.productsTitle}</h2>
        )}

        {(activeCategory || q) && (
          <h1 className="font-serif text-2xl text-gray-900">
            {activeCategory ? activeCategory.name : `Resultados para "${q}"`}
          </h1>
        )}

        {settings.showCategories && (
          <CategoryMobileButton categories={categories} activeSlug={categoria ?? null} search={q} />
        )}

      <div className="flex gap-8">
        {settings.showCategories && (
          <CategorySidebar categories={categories} activeSlug={categoria ?? null} search={q} />
        )}

        <div className="flex-1 min-w-0">
          {result.products.length === 0 ? (
            <div className="py-16 text-center text-sm text-gray-500">
              {texts.emptyMessage(q)}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-5">
                {result.products.map((p) => <ProductCard key={p.productId} product={p} basePath={basePath} />)}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 pt-8">
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => {
                    const params = new URLSearchParams()
                    if (q) params.set('q', q)
                    if (categoria) params.set('categoria', categoria)
                    params.set('page', String(p))
                    return (
                      <Link
                        key={p}
                        href={`${wholesaleHref(basePath, '/')}?${params.toString()}#produtos`}
                        className={`w-8 h-8 flex items-center justify-center rounded-full text-sm font-medium transition-colors ${
                          p === pageNumber ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-100'
                        }`}
                      >
                        {p}
                      </Link>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      </section>
    </div>
  )
}
