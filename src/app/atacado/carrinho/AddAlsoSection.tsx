'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ImageOff, Plus } from 'lucide-react'
import { formatCurrency } from '@/lib/utils/currency'
import { trackAddToCart } from '@/lib/wholesale/metaPixel'
import { useCart } from '../_lib/CartContext'
import { availableVariations, buildCartItem, cartProductIds, filterRecommendations, variationLabel } from '../_lib/cartItem'
import type { WholesaleCatalogProduct } from '@/services/wholesale/catalog'

const SEED_KEY = 'santtorini_wholesale_reco_seed_v1'
const SHOW_MAX = 6

/** Semente da sessão (sessionStorage): muda entre visitas, fica fixa enquanto o cliente mexe no carrinho. */
function sessionSeed(): string {
  const fresh = () => Math.random().toString(36).slice(2, 12)
  try {
    const saved = sessionStorage.getItem(SEED_KEY)
    if (saved && /^[A-Za-z0-9_-]{1,64}$/.test(saved)) return saved
    const next = fresh()
    sessionStorage.setItem(SEED_KEY, next)
    return next
  } catch {
    return fresh()
  }
}

function RecommendationCard({ product }: { product: WholesaleCatalogProduct }) {
  const { addItem } = useCart()
  const options = availableVariations(product)
  const [selectedId, setSelectedId] = useState<number>(options[0]?.variationId ?? 0)
  const selected = options.find((v) => v.variationId === selectedId) ?? options[0]
  const cover = product.images[0]

  if (!selected) return null

  const prices = options.map((v) => v.price)
  const priceVaries = options.length > 1 && Math.max(...prices) !== Math.min(...prices)

  function handleAdd() {
    addItem(buildCartItem(product, selected), 1)
    trackAddToCart({ contentId: String(selected.variationId), contentName: product.name, value: selected.price, quantity: 1 })
    toast.success('Adicionado ao carrinho!')
  }

  return (
    <li className="flex flex-col rounded-xl border border-gray-100 bg-white p-2.5">
      <div className="aspect-square overflow-hidden rounded-lg bg-gray-50 flex items-center justify-center">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover.url} alt={cover.alt ?? product.name} loading="lazy" decoding="async" className="h-full w-full object-cover" />
        ) : (
          <ImageOff className="h-6 w-6 text-gray-300" />
        )}
      </div>

      <h3 className="mt-2 line-clamp-2 min-h-[2.5rem] text-[13px] leading-snug text-gray-800">{product.name}</h3>
      <p className="mt-0.5 text-sm font-semibold text-gray-900">
        {formatCurrency(selected.price)}
      </p>

      {options.length > 1 && (
        <select
          aria-label={`Variação de ${product.name}`}
          value={selected.variationId}
          onChange={(e) => setSelectedId(Number(e.target.value))}
          className="mt-1.5 w-full rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
        >
          {options.map((v) => (
            <option key={v.variationId} value={v.variationId}>
              {variationLabel(v.attributes, v.sku)}{priceVaries ? ` — ${formatCurrency(v.price)}` : ''}
            </option>
          ))}
        </select>
      )}

      <button
        type="button"
        onClick={handleAdd}
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-full bg-gray-900 py-2.5 text-xs font-medium text-white transition-colors hover:bg-gray-800 active:scale-[0.98]"
      >
        <Plus className="h-3.5 w-3.5" /> Adicionar
      </button>
    </li>
  )
}

export function AddAlsoSection({ title = 'Adicione também' }: { title?: string }) {
  const { items, ready } = useCart()
  const [products, setProducts] = useState<WholesaleCatalogProduct[]>([])

  const inCart = useMemo(() => cartProductIds(items), [items])
  const inCartKey = inCart.join(',')

  // Busca no servidor (regras de elegibilidade ficam lá) quando o conjunto de PRODUTOS do carrinho muda.
  // A seed fixa mantém a ordem; a lista anterior continua na tela enquanto carrega (sem piscar).
  useEffect(() => {
    if (!ready || inCart.length === 0) return
    const controller = new AbortController()
    const params = new URLSearchParams({ exclude: inCartKey, seed: sessionSeed(), limit: String(SHOW_MAX) })

    fetch(`/api/wholesale/recomendacoes?${params.toString()}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { if (json && Array.isArray(json.products)) setProducts(json.products) })
      .catch(() => { /* recomendação é complemento: falha de rede não atrapalha o carrinho */ })

    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, inCartKey])

  // Reação imediata ao carrinho (antes mesmo do refetch): quem entrou no carrinho sai da lista.
  const visible = useMemo(() => filterRecommendations(products, inCart).slice(0, SHOW_MAX), [products, inCart])

  if (!ready || items.length === 0 || visible.length === 0) return null

  return (
    <section aria-labelledby="adicione-tambem" className="space-y-3 pt-2">
      <h2 id="adicione-tambem" className="font-serif text-xl text-gray-900">{title}</h2>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {visible.map((product) => <RecommendationCard key={product.productId} product={product} />)}
      </ul>
    </section>
  )
}
