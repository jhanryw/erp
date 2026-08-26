'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ImageOff, Minus, Plus, ShoppingCart } from 'lucide-react'
import { formatCurrency } from '@/lib/utils/currency'
import { useCart } from '../../_lib/CartContext'
import type { WholesaleCatalogProduct } from '@/services/wholesale/catalog'

export function ProductDetailClient({ product }: { product: WholesaleCatalogProduct }) {
  const { addItem } = useCart()
  const router = useRouter()
  const [selectedVariationId, setSelectedVariationId] = useState<number | null>(
    product.variations.find((v) => v.available)?.variationId ?? product.variations[0]?.variationId ?? null,
  )
  const [quantity, setQuantity] = useState(1)

  const selected = useMemo(
    () => product.variations.find((v) => v.variationId === selectedVariationId) ?? null,
    [product.variations, selectedVariationId],
  )

  function handleAddToCart() {
    if (!selected || !selected.available) {
      toast.error('Preço de atacado não cadastrado para esta variação.')
      return
    }
    addItem({
      variationId: selected.variationId,
      productId: product.productId,
      productName: product.name,
      sku: selected.sku,
      attributes: selected.attributes.map((a) => a.value).join(' · '),
      displayPrice: selected.price,
      imageUrl: product.images[0]?.url ?? null,
    }, quantity)
    toast.success('Adicionado ao carrinho!')
    setQuantity(1)
  }

  return (
    <div className="grid md:grid-cols-2 gap-8">
      <div className="aspect-square rounded-xl bg-bg-overlay flex items-center justify-center overflow-hidden">
        {product.images[0] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={product.images[0].url} alt={product.images[0].alt ?? product.name} className="w-full h-full object-cover" />
        ) : (
          <ImageOff className="w-12 h-12 text-text-muted" />
        )}
      </div>

      <div className="space-y-4">
        <div>
          {product.brand && <p className="text-xs text-text-muted uppercase tracking-wide">{product.brand}</p>}
          <h1 className="text-2xl font-bold text-text-primary">{product.name}</h1>
          {product.category && <p className="text-sm text-text-muted mt-0.5">{product.category}</p>}
        </div>

        {product.purchasable ? (
          <p className="text-3xl font-bold text-text-primary">{formatCurrency(selected?.price ?? product.priceFrom ?? 0)}</p>
        ) : (
          <div className="rounded-lg bg-warning/10 border border-warning/30 px-3 py-2 text-sm text-warning font-medium">
            Produto indisponível para atacado no momento.
          </div>
        )}

        {product.variations.length > 1 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-text-secondary">Variação</p>
            <div className="flex flex-wrap gap-2">
              {product.variations.map((v) => (
                <button
                  key={v.variationId}
                  onClick={() => setSelectedVariationId(v.variationId)}
                  disabled={!v.available}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                    selectedVariationId === v.variationId
                      ? 'bg-brand text-white border-brand'
                      : v.available
                        ? 'bg-bg-card border-border text-text-secondary hover:border-brand/40'
                        : 'bg-bg-overlay border-border text-text-muted opacity-50 cursor-not-allowed line-through'
                  }`}
                >
                  {v.attributes.map((a) => a.value).join(' / ') || v.sku}
                </button>
              ))}
            </div>
          </div>
        )}

        {selected?.available && selected.lowStock && (
          <p className="text-xs text-warning">Poucas unidades disponíveis.</p>
        )}

        {selected && !selected.available && (
          <p className="text-xs text-error">Esta variação não está disponível para compra no atacado.</p>
        )}

        <div className="flex items-center gap-3 pt-2">
          <div className="flex items-center border border-border rounded-lg">
            <button onClick={() => setQuantity((q) => Math.max(1, q - 1))} className="p-2 text-text-secondary hover:text-text-primary">
              <Minus className="w-4 h-4" />
            </button>
            <span className="w-10 text-center text-sm font-medium tabular-nums">{quantity}</span>
            <button onClick={() => setQuantity((q) => q + 1)} className="p-2 text-text-secondary hover:text-text-primary">
              <Plus className="w-4 h-4" />
            </button>
          </div>
          <button
            onClick={handleAddToCart}
            disabled={!selected?.available}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg bg-brand text-white font-medium hover:bg-brand-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ShoppingCart className="w-4 h-4" />
            Adicionar ao carrinho
          </button>
        </div>

        <button onClick={() => router.push('/atacado/carrinho')} className="text-xs text-text-muted hover:text-text-primary underline">
          Ver carrinho
        </button>
      </div>
    </div>
  )
}
