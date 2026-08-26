import type { Metadata } from 'next'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { getWholesaleCatalogPage, listWholesaleCategories } from '@/services/wholesale/catalog'
import { getActiveWholesaleBanners } from '@/services/wholesale/banners'
import { getWholesaleSiteSettings } from '@/services/wholesale/settings'
import { ProductCard } from './_components/ProductCard'
import { CategoryMobileButton, CategorySidebar } from './_components/CategoryNav'
import { BannerCarousel } from './_components/BannerCarousel'
import { getWholesaleBasePath } from '@/lib/wholesale/requestContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'

export const dynamic = 'force-dynamic'

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

  const pageNumber = Math.max(1, Number(page ?? '1') || 1)
  const [settings, result, categories, banners] = await Promise.all([
    getWholesaleSiteSettings(tenant.companyId),
    getWholesaleCatalogPage(tenant.companyId, { search: q, categorySlug: categoria, page: pageNumber }),
    listWholesaleCategories(tenant.companyId),
    getActiveWholesaleBanners(tenant.companyId),
  ])
  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize))

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        {settings.showSearch && (
          <form method="GET" className="flex gap-2 max-w-md">
            {categoria && <input type="hidden" name="categoria" value={categoria} />}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                name="q"
                defaultValue={q ?? ''}
                placeholder="Buscar produtos..."
                className="w-full pl-9 pr-3 py-2.5 rounded-full border border-gray-200 bg-white text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
              />
            </div>
          </form>
        )}

        {settings.showCategories && (
          <CategoryMobileButton categories={categories} activeSlug={categoria ?? null} search={q} />
        )}
      </div>

      {banners.length > 0 && <BannerCarousel banners={banners} />}

      <div className="flex gap-8">
        {settings.showCategories && (
          <CategorySidebar categories={categories} activeSlug={categoria ?? null} search={q} />
        )}

        <div className="flex-1 min-w-0">
          {result.products.length === 0 ? (
            <div className="py-16 text-center text-sm text-gray-500">
              Nenhum produto encontrado{q ? ` para "${q}"` : ''}.
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
                        href={`${wholesaleHref(basePath, '/')}?${params.toString()}`}
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
    </div>
  )
}
