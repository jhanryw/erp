'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Minus, Plus, Trash2, ImageOff, ShoppingBag } from 'lucide-react'
import { formatCurrency } from '@/lib/utils/currency'
import { useCart } from '../_lib/CartContext'
import { useWholesaleBasePath } from '../_lib/WholesaleBasePathContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'

export default function CarrinhoPage() {
  const { items, updateQuantity, removeItem, totalDisplayValue } = useCart()
  const router = useRouter()
  const basePath = useWholesaleBasePath()

  if (items.length === 0) {
    return (
      <div className="py-16 text-center space-y-3">
        <ShoppingBag className="w-10 h-10 text-text-muted mx-auto" />
        <p className="text-text-muted">Seu carrinho está vazio.</p>
        <Link href={wholesaleHref(basePath, '/')} className="inline-block text-sm text-brand font-medium hover:underline">
          Ver catálogo
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold text-text-primary">Carrinho</h1>

      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.variationId} className="flex gap-3 p-3 rounded-xl border border-border bg-bg-card">
            <div className="w-16 h-16 rounded-lg bg-bg-overlay flex items-center justify-center overflow-hidden shrink-0">
              {item.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.imageUrl} alt={item.productName} className="w-full h-full object-cover" />
              ) : (
                <ImageOff className="w-5 h-5 text-text-muted" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">{item.productName}</p>
              {item.attributes && <p className="text-xs text-text-muted">{item.attributes}</p>}
              <p className="text-sm font-semibold text-text-primary mt-1">{formatCurrency(item.displayPrice)}</p>
            </div>
            <div className="flex flex-col items-end justify-between">
              <button onClick={() => removeItem(item.variationId)} className="text-text-muted hover:text-error">
                <Trash2 className="w-4 h-4" />
              </button>
              <div className="flex items-center border border-border rounded-lg">
                <button onClick={() => updateQuantity(item.variationId, item.quantity - 1)} className="p-1.5 text-text-secondary hover:text-text-primary">
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <span className="w-8 text-center text-xs font-medium tabular-nums">{item.quantity}</span>
                <button onClick={() => updateQuantity(item.variationId, item.quantity + 1)} className="p-1.5 text-text-secondary hover:text-text-primary">
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-bg-card p-4 space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-text-secondary">Subtotal estimado</span>
          <span className="font-semibold text-text-primary">{formatCurrency(totalDisplayValue)}</span>
        </div>
        <p className="text-xs text-text-muted">
          O valor final é sempre recalculado no fechamento do pedido, com preço e disponibilidade atuais.
        </p>
        <button
          onClick={() => router.push(wholesaleHref(basePath, '/checkout'))}
          className="w-full py-2.5 rounded-lg bg-brand text-white font-medium hover:bg-brand-dark transition-colors"
        >
          Fechar pedido
        </button>
      </div>
    </div>
  )
}
