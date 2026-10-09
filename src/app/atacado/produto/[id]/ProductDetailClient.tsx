'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ImageOff, ShoppingCart } from 'lucide-react'
import { formatCurrency } from '@/lib/utils/currency'
import { useCart } from '../../_lib/CartContext'
import { useWholesaleBasePath } from '../../_lib/WholesaleBasePathContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'
import { trackViewContent, trackAddToCart } from '@/lib/wholesale/metaPixel'
import { variationLabel } from '../../_lib/cartItem'
import { buildCartLines, clampQuantity, familyProducts, summarizeSelection, type FamilyQuantities } from '../../_lib/familySelection'
import { CatalogImage } from '../../_components/CatalogImage'
import { QuantityStepper } from '../../_components/QuantityStepper'
import type { WholesaleCatalogProduct } from '@/services/wholesale/catalog'

export function ProductDetailClient({ product }: { product: WholesaleCatalogProduct }) {
  const { addItem } = useCart()
  const router = useRouter()
  const basePath = useWholesaleBasePath()

  const products = useMemo(() => familyProducts(product), [product])
  const hasFamily = products.length > 1

  // Produto (cor) em exibição + quantidades por VARIAÇÃO de todas as cores: trocar de cor não perde nada.
  const [activeId, setActiveId] = useState(product.productId)
  const [quantities, setQuantities] = useState<FamilyQuantities>({})
  const active = products.find((p) => p.productId === activeId) ?? product

  useEffect(() => {
    trackViewContent({ contentId: String(product.productId), contentName: product.name, value: product.priceFrom ?? 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.productId])

  const summary = useMemo(() => summarizeSelection(products, quantities), [products, quantities])

  function selectColor(next: WholesaleCatalogProduct) {
    setActiveId(next.productId)
    // Mantém a URL compartilhável da cor em exibição sem recarregar a página.
    try { window.history.replaceState(null, '', wholesaleHref(basePath, `/produto/${next.productId}`)) } catch { /* ignora */ }
  }

  function setQty(variationId: number, value: number) {
    const variation = products.flatMap((p) => p.variations).find((v) => v.variationId === variationId)
    if (!variation) return
    setQuantities((prev) => ({ ...prev, [variationId]: clampQuantity(variation, value) }))
  }

  function handleAddToCart() {
    const lines = buildCartLines(products, quantities)
    if (lines.length === 0) {
      toast.error('Escolha ao menos uma quantidade.')
      return
    }
    for (const { item, quantity } of lines) {
      addItem(item, quantity)
      trackAddToCart({ contentId: String(item.variationId), contentName: item.productName, value: item.displayPrice, quantity })
    }
    toast.success(lines.length === 1 ? 'Adicionado ao carrinho!' : `${summary.units} peças (${lines.length} itens) adicionadas ao carrinho!`)
    setQuantities({})
  }

  const image = active.images[0]

  return (
    <div className="grid md:grid-cols-2 gap-8 md:gap-12">
      <div className="relative aspect-square rounded-xl bg-gray-50 flex items-center justify-center overflow-hidden">
        {image ? (
          // key: ao trocar de cor a imagem é a DA COR escolhida.
          <CatalogImage key={active.productId} src={image.url} alt={image.alt ?? active.name} sizes="(min-width: 768px) 50vw, 100vw" priority className="object-cover" />
        ) : (
          <ImageOff aria-hidden className="w-12 h-12 text-gray-500" />
        )}
      </div>

      <div className="space-y-5">
        <div>
          {active.brand && <p className="text-xs text-gray-500 uppercase tracking-wide">{active.brand}</p>}
          <h1 className="text-xl font-semibold text-gray-900 mt-0.5">{active.name}</h1>
          {active.category && <p className="text-sm text-gray-500 mt-0.5">{active.category}</p>}
        </div>

        {hasFamily && (
          <section aria-label="Cores" className="space-y-2">
            <p className="text-sm font-medium text-gray-900">
              Cor: <span className="font-normal text-gray-700">{active.colorLabel ?? active.name}</span>
            </p>
            <ul className="flex flex-wrap gap-2">
              {products.map((p) => {
                const selected = p.productId === activeId
                const picked = summary.unitsByProduct[p.productId] ?? 0
                const unavailable = !p.purchasable
                const label = p.colorLabel ?? p.name
                return (
                  <li key={p.productId}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      aria-label={`${label}${unavailable ? ' — indisponível' : ''}${picked ? ` — ${picked} selecionadas` : ''}`}
                      onClick={() => selectColor(p)}
                      className={`relative flex w-[72px] flex-col items-center gap-1 rounded-lg border p-1.5 text-center transition-colors ${
                        selected ? 'border-gray-900 ring-2 ring-gray-900' : 'border-gray-400 hover:border-gray-900'
                      } ${unavailable ? 'bg-gray-50' : 'bg-white'}`}
                    >
                      <span className="relative block h-14 w-14 overflow-hidden rounded-md bg-gray-100">
                        {p.images[0] ? (
                          <CatalogImage src={p.images[0].url} alt="" sizes="56px" className={`object-cover ${unavailable ? 'opacity-40 grayscale' : ''}`} />
                        ) : (
                          <ImageOff aria-hidden className="m-auto mt-4 h-5 w-5 text-gray-500" />
                        )}
                      </span>
                      <span className={`line-clamp-2 min-h-[2rem] text-[11px] leading-tight ${unavailable ? 'text-gray-500' : 'text-gray-900'}`}>{label}</span>
                      {unavailable && <span className="text-[10px] leading-none text-gray-600">Indisponível</span>}
                      {picked > 0 && (
                        <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-gray-900 px-1 text-[11px] font-semibold text-white">
                          {picked}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {!active.purchasable && (
          <div className="rounded-lg bg-amber-50 border border-amber-300 px-3 py-2 text-sm text-amber-800 font-medium">
            Esta cor está indisponível no momento.
          </div>
        )}

        {active.purchasable && (
          <div className="space-y-1">
            <p className="text-sm font-medium text-gray-900">Tamanho e quantidade</p>
            {active.variations.map((v) => {
              const qty = quantities[v.variationId] ?? 0
              // A cor já aparece no seletor de cores; só é repetida no rótulo quando o produto mistura várias cores.
              const label = variationLabel(active.colorLabel ? v.attributes.filter((a) => a.type.toLowerCase() !== 'cor') : v.attributes, v.sku)
              return (
                <div key={v.variationId} className={`flex items-center justify-between gap-3 border-b border-gray-200 py-2.5 ${!v.available ? 'bg-gray-50' : ''}`}>
                  <div className="min-w-0">
                    <p className={`text-sm font-medium ${v.available ? 'text-gray-900' : 'text-gray-500'}`}>{label}</p>
                    <p className={`text-sm font-semibold ${v.available ? 'text-gray-900' : 'text-gray-500'}`}>{formatCurrency(v.price)}</p>
                    {v.available && v.lowStock && <p className="text-xs text-amber-700">Poucas unidades</p>}
                    {!v.available && <p className="text-xs text-gray-600">Indisponível</p>}
                  </div>
                  <QuantityStepper
                    value={qty}
                    max={v.maxQuantity}
                    disabled={!v.available}
                    label={`${active.colorLabel ?? active.name} ${label}`}
                    onChange={(next) => setQty(v.variationId, next)}
                  />
                </div>
              )
            })}
          </div>
        )}

        <div className="space-y-3 pt-1" aria-live="polite">
          <div className="flex items-baseline justify-between text-sm text-gray-700">
            <span>
              {summary.units > 0
                ? `${summary.units} ${summary.units === 1 ? 'peça selecionada' : 'peças selecionadas'}${Object.keys(summary.unitsByProduct).length > 1 ? ` em ${Object.keys(summary.unitsByProduct).length} cores` : ''}`
                : 'Nenhuma peça selecionada'}
            </span>
            <span className="text-base font-semibold text-gray-900">{formatCurrency(summary.subtotal)}</span>
          </div>
          <button
            type="button"
            onClick={handleAddToCart}
            aria-disabled={summary.units === 0}
            className={`w-full flex items-center justify-center gap-2 py-3.5 rounded-full text-sm font-medium transition-colors ${
              summary.units === 0 ? 'bg-gray-200 text-gray-700' : 'bg-gray-900 text-white hover:bg-gray-800 active:bg-black'
            }`}
          >
            <ShoppingCart aria-hidden className="w-4 h-4" />
            {summary.units === 0 ? 'Escolha as quantidades' : `Adicionar ${summary.units} ${summary.units === 1 ? 'peça' : 'peças'} ao carrinho`}
          </button>
        </div>

        <button type="button" onClick={() => router.push(wholesaleHref(basePath, '/carrinho'))} className="text-sm text-gray-700 hover:text-gray-900 underline">
          Ver carrinho
        </button>
      </div>
    </div>
  )
}
