import Link from 'next/link'
import { ImageOff } from 'lucide-react'
import { formatCurrency } from '@/lib/utils/currency'
import type { WholesaleCatalogProduct } from '@/services/wholesale/catalog'
import { wholesaleHref } from '@/lib/wholesale/site-host'

export function ProductCard({ product, basePath }: { product: WholesaleCatalogProduct; basePath: string }) {
  const cover = product.images[0]

  return (
    <Link
      href={wholesaleHref(basePath, `/produto/${product.productId}`)}
      className="group flex flex-col"
    >
      <div className="aspect-square bg-gray-50 rounded-lg flex items-center justify-center overflow-hidden">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover.url} alt={cover.alt ?? product.name} className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300" />
        ) : (
          <ImageOff className="w-8 h-8 text-gray-300" />
        )}
      </div>
      <div className="pt-2.5 space-y-0.5">
        {product.brand && <span className="text-[11px] text-gray-400 uppercase tracking-wide">{product.brand}</span>}
        <h3 className="text-sm text-gray-800 line-clamp-2 leading-snug">{product.name}</h3>
        {product.purchasable ? (
          <p className="text-sm font-semibold text-gray-900 pt-0.5">
            {product.priceFrom != null && <span className="font-normal text-gray-400 text-xs">a partir de </span>}
            {formatCurrency(product.priceFrom ?? 0)}
          </p>
        ) : (
          <p className="text-xs text-gray-400 pt-0.5">Indisponível</p>
        )}
      </div>
    </Link>
  )
}
