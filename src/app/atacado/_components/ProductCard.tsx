import Link from 'next/link'
import { ImageOff } from 'lucide-react'
import { formatCurrency } from '@/lib/utils/currency'
import type { WholesaleCatalogProduct } from '@/services/wholesale/catalog'

export function ProductCard({ product }: { product: WholesaleCatalogProduct }) {
  const cover = product.images[0]

  return (
    <Link
      href={`/atacado/produto/${product.productId}`}
      className="group flex flex-col rounded-xl border border-border bg-bg-card overflow-hidden hover:border-brand/50 hover:shadow-md transition-all"
    >
      <div className="aspect-square bg-bg-overlay flex items-center justify-center overflow-hidden">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover.url} alt={cover.alt ?? product.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
        ) : (
          <ImageOff className="w-8 h-8 text-text-muted" />
        )}
      </div>
      <div className="p-3 space-y-1 flex-1 flex flex-col">
        {product.brand && <span className="text-[11px] text-text-muted uppercase tracking-wide">{product.brand}</span>}
        <h3 className="text-sm font-medium text-text-primary line-clamp-2 flex-1">{product.name}</h3>
        <div className="pt-1">
          {product.purchasable ? (
            <span className="text-base font-bold text-text-primary">
              {product.priceFrom != null && `a partir de `}
              {formatCurrency(product.priceFrom ?? 0)}
            </span>
          ) : (
            <span className="text-xs font-medium text-text-muted">Indisponível para atacado</span>
          )}
        </div>
      </div>
    </Link>
  )
}
