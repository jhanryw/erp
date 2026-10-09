import Link from 'next/link'
import { wholesaleHref } from '@/lib/wholesale/site-host'
import { CatalogImage } from './CatalogImage'
import type { WholesaleCategory } from '@/services/wholesale/catalog'

/** Link da categoria: filtra a vitrine pela chave pública e rola até a lista de produtos. */
export function categoryCardHref(basePath: string, category: Pick<WholesaleCategory, 'key'>): string {
  return `${wholesaleHref(basePath, '/')}?categoria=${encodeURIComponent(category.key)}#produtos`
}

function CategoryCard({ category, basePath, priority }: { category: WholesaleCategory; basePath: string; priority: boolean }) {
  return (
    <Link
      href={categoryCardHref(basePath, category)}
      className="group relative block aspect-[4/5] overflow-hidden rounded-2xl bg-gradient-to-br from-stone-100 via-rose-50 to-stone-200 ring-1 ring-black/5"
    >
      {category.imageUrl && (
        <CatalogImage
          src={category.imageUrl}
          alt={category.imageAlt ?? ''}
          sizes="(min-width: 1152px) 270px, (min-width: 640px) 31vw, 47vw"
          priority={priority}
          className="object-cover transition-transform duration-500 group-hover:scale-[1.04]"
        />
      )}

      {category.imageUrl && <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-transparent" />}

      <div className="absolute inset-x-0 bottom-0 p-3.5 sm:p-4">
        <h3 className={`font-serif text-lg leading-tight sm:text-xl ${category.imageUrl ? 'text-white' : 'text-gray-900'}`}>
          {category.name}
        </h3>
        <p className={`mt-1 text-[11px] uppercase tracking-[0.14em] ${category.imageUrl ? 'text-white/80' : 'text-gray-500'}`}>
          Ver peças <span aria-hidden>→</span>
        </p>
      </div>
    </Link>
  )
}

export function CategoryGrid({ categories, basePath, title = 'Nossas categorias', eagerCount = 2 }: { categories: WholesaleCategory[]; basePath: string; title?: string; /** Quantos cards carregam já (só quando não há banner acima — senão o LCP é o banner). */ eagerCount?: number }) {
  if (categories.length === 0) return null

  return (
    <section aria-labelledby="categorias-titulo" className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-brand">Compre por categoria</p>
          <h2 id="categorias-titulo" className="font-serif text-2xl text-gray-900 sm:text-3xl">{title}</h2>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
        {categories.map((category, index) => (
          <CategoryCard key={category.id} category={category} basePath={basePath} priority={index < eagerCount} />
        ))}
      </div>
    </section>
  )
}
