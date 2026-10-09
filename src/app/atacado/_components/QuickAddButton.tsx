'use client'

import Link from 'next/link'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { trackAddToCart } from '@/lib/wholesale/metaPixel'
import { wholesaleHref } from '@/lib/wholesale/site-host'
import { useCart } from '../_lib/CartContext'
import { availableVariations, buildCartItem } from '../_lib/cartItem'
import type { WholesaleCatalogProduct } from '@/services/wholesale/catalog'

/**
 * Adição rápida na listagem: produto com UMA variação comprável entra direto (1 unidade);
 * com várias, leva à página do produto para escolher (nunca adivinha tamanho/cor).
 */
export function QuickAddButton({ product, basePath }: { product: WholesaleCatalogProduct; basePath: string }) {
  const { addItem } = useCart()
  const options = availableVariations(product)

  if (!product.purchasable || options.length === 0) return null

  const cls = 'mt-2 flex w-full items-center justify-center gap-1.5 rounded-full border border-gray-200 py-2 text-xs font-medium text-gray-800 transition-colors hover:border-gray-900 hover:bg-gray-900 hover:text-white active:scale-[0.98]'

  if (options.length > 1) {
    return <Link href={wholesaleHref(basePath, `/produto/${product.productId}`)} className={cls}>Escolher opções</Link>
  }

  const only = options[0]
  return (
    <button
      type="button"
      className={cls}
      onClick={() => {
        addItem(buildCartItem(product, only), 1)
        trackAddToCart({ contentId: String(only.variationId), contentName: product.name, value: only.price, quantity: 1 })
        toast.success('Adicionado ao carrinho!')
      }}
    >
      <Plus className="h-3.5 w-3.5" /> Adicionar
    </button>
  )
}
