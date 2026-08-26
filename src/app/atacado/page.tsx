import type { Metadata } from 'next'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { getWholesaleCatalogPage } from '@/services/wholesale/catalog'
import { ProductCard } from './_components/ProductCard'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Catálogo',
  description: 'Catálogo de atacado Santtorini — preços e disponibilidade em tempo real.',
}

type SearchParams = Promise<{ q?: string; page?: string }>

export default async function AtacadoHomePage({ searchParams }: { searchParams: SearchParams }) {
  const { q, page } = await searchParams
  const tenant = await resolveWholesaleSiteTenant()

  if (!tenant) {
    return (
      <div className="py-20 text-center">
        <p className="text-text-muted">Site de atacado ainda não configurado. Volte em breve.</p>
      </div>
    )
  }

  const pageNumber = Math.max(1, Number(page ?? '1') || 1)
  const result = await getWholesaleCatalogPage(tenant.companyId, { search: q, page: pageNumber })
  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize))

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-bold text-text-primary">Catálogo de Atacado</h1>
        <form method="GET" className="flex gap-2 max-w-md">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              type="text"
              name="q"
              defaultValue={q ?? ''}
              placeholder="Buscar produtos..."
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-bg-input text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand/40"
            />
          </div>
          <button type="submit" className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-dark transition-colors">
            Buscar
          </button>
        </form>
      </div>

      {result.products.length === 0 ? (
        <div className="py-16 text-center text-sm text-text-muted">
          Nenhum produto encontrado{q ? ` para "${q}"` : ''}.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {result.products.map((p) => <ProductCard key={p.productId} product={p} />)}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-4">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <Link
                  key={p}
                  href={`/atacado?${q ? `q=${encodeURIComponent(q)}&` : ''}page=${p}`}
                  className={`w-8 h-8 flex items-center justify-center rounded-lg text-sm font-medium transition-colors ${
                    p === pageNumber ? 'bg-brand text-white' : 'bg-bg-card border border-border text-text-secondary hover:bg-bg-hover'
                  }`}
                >
                  {p}
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
