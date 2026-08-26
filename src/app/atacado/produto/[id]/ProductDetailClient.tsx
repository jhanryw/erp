'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ImageOff, Minus, Plus, ShoppingCart } from 'lucide-react'
import { formatCurrency } from '@/lib/utils/currency'
import { useCart } from '../../_lib/CartContext'
import { useWholesaleBasePath } from '../../_lib/WholesaleBasePathContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'
import { trackViewContent, trackAddToCart } from '@/lib/wholesale/metaPixel'
import type { WholesaleCatalogProduct } from '@/services/wholesale/catalog'

/** Rótulo de uma variação — atributos (ex.: "Cor: Preto / Tamanho: M") ou o SKU quando o produto não tem variante de fato. */
function variationLabel(attributes: { type: string; value: string }[], sku: string): string {
  return attributes.map((a) => a.value).join(' / ') || sku
}

export function ProductDetailClient({ product }: { product: WholesaleCatalogProduct }) {
  const { addItem } = useCart()
  const router = useRouter()
  const basePath = useWholesaleBasePath()

  // Quantidade PENDENTE por variação — o cliente monta o pedido de várias
  // variações (P/M/G) antes de adicionar tudo de uma vez (seção 8 do
  // pedido) — nunca precisa reabrir o produto pra cada tamanho.
  const [quantities, setQuantities] = useState<Record<number, number>>({})

  useEffect(() => {
    trackViewContent({
      contentId: String(product.productId),
      contentName: product.name,
      value: product.priceFrom ?? 0,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.productId])

  const selectedTotal = useMemo(
    () => product.variations.reduce((sum, v) => sum + (quantities[v.variationId] ?? 0) * v.price, 0),
    [product.variations, quantities],
  )
  const selectedUnits = useMemo(
    () => Object.values(quantities).reduce((sum, q) => sum + q, 0),
    [quantities],
  )

  function setQty(variationId: number, next: number, max: number | undefined) {
    const clamped = Math.max(0, max != null ? Math.min(next, max) : next)
    setQuantities((prev) => ({ ...prev, [variationId]: clamped }))
  }

  function handleAddToCart() {
    const toAdd = product.variations.filter((v) => (quantities[v.variationId] ?? 0) > 0)
    if (toAdd.length === 0) {
      toast.error('Escolha ao menos uma quantidade.')
      return
    }

    for (const v of toAdd) {
      const qty = quantities[v.variationId]
      addItem({
        variationId: v.variationId,
        productId: product.productId,
        productName: product.name,
        sku: v.sku,
        attributes: v.attributes.map((a) => a.value).join(' · '),
        displayPrice: v.price,
        imageUrl: product.images[0]?.url ?? null,
      }, qty)
      trackAddToCart({ contentId: String(v.variationId), contentName: product.name, value: v.price, quantity: qty })
    }

    toast.success(toAdd.length === 1 ? 'Adicionado ao carrinho!' : `${toAdd.length} variações adicionadas ao carrinho!`)
    setQuantities({})
  }

  return (
    <div className="grid md:grid-cols-2 gap-8 md:gap-12">
      <div className="aspect-square rounded-xl bg-gray-50 flex items-center justify-center overflow-hidden">
        {product.images[0] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={product.images[0].url} alt={product.images[0].alt ?? product.name} className="w-full h-full object-cover" />
        ) : (
          <ImageOff className="w-12 h-12 text-gray-300" />
        )}
      </div>

      <div className="space-y-5">
        <div>
          {product.brand && <p className="text-xs text-gray-400 uppercase tracking-wide">{product.brand}</p>}
          <h1 className="text-xl font-semibold text-gray-900 mt-0.5">{product.name}</h1>
          {product.category && <p className="text-sm text-gray-400 mt-0.5">{product.category}</p>}
        </div>

        {!product.purchasable && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-700 font-medium">
            Produto indisponível no momento.
          </div>
        )}

        {product.purchasable && (
          <div className="space-y-2">
            {product.variations.map((v) => {
              const qty = quantities[v.variationId] ?? 0
              return (
                <div key={v.variationId} className={`flex items-center justify-between gap-3 py-2 border-b border-gray-100 ${!v.available ? 'opacity-40' : ''}`}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-800">{variationLabel(v.attributes, v.sku)}</p>
                    <p className="text-sm text-gray-900 font-semibold">{formatCurrency(v.price)}</p>
                    {v.available && v.lowStock && <p className="text-xs text-amber-600">Poucas unidades</p>}
                    {!v.available && <p className="text-xs text-gray-400">Indisponível</p>}
                  </div>

                  <div className="flex items-center border border-gray-200 rounded-lg shrink-0">
                    <button
                      type="button"
                      disabled={!v.available}
                      onClick={() => setQty(v.variationId, qty - 1, v.stockQuantity)}
                      className="p-2 text-gray-500 hover:text-gray-900 disabled:opacity-30"
                    >
                      <Minus className="w-3.5 h-3.5" />
                    </button>
                    <span className="w-8 text-center text-sm font-medium tabular-nums">{qty}</span>
                    <button
                      type="button"
                      disabled={!v.available}
                      onClick={() => setQty(v.variationId, qty + 1, v.stockQuantity)}
                      className="p-2 text-gray-500 hover:text-gray-900 disabled:opacity-30"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {product.purchasable && (
          <div className="space-y-3 pt-1">
            {selectedUnits > 0 && (
              <div className="flex justify-between text-sm text-gray-600">
                <span>{selectedUnits} un. selecionadas</span>
                <span className="font-semibold text-gray-900">{formatCurrency(selectedTotal)}</span>
              </div>
            )}
            <button
              onClick={handleAddToCart}
              disabled={selectedUnits === 0}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-full bg-gray-900 text-white text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ShoppingCart className="w-4 h-4" />
              Adicionar ao carrinho
            </button>
          </div>
        )}

        <button onClick={() => router.push(wholesaleHref(basePath, '/carrinho'))} className="text-xs text-gray-400 hover:text-gray-700 underline">
          Ver carrinho
        </button>
      </div>
    </div>
  )
}
