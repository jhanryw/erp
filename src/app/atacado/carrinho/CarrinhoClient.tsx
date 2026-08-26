'use client'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Minus, Plus, Trash2, ImageOff, ShoppingBag, MessageCircle } from 'lucide-react'
import { formatCurrency } from '@/lib/utils/currency'
import { useCart } from '../_lib/CartContext'
import { useWholesaleBasePath } from '../_lib/WholesaleBasePathContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'
import { buildWhatsAppOrderMessage } from '@/lib/wholesale/whatsapp'
import { trackInitiateCheckout } from '@/lib/wholesale/metaPixel'

interface Props {
  minimumOrderAmount: number
  whatsappPhone: string | null
  displayName: string | null
}

type ValidationItem =
  | { variationId: number; ok: true; price: number; availableQuantity: number }
  | { variationId: number; ok: false; reason: 'not_found' | 'inactive' | 'no_wholesale_price' | 'insufficient_stock'; price: number | null; availableQuantity: number }

const REASON_LABEL: Record<string, string> = {
  not_found: 'não existe mais',
  inactive: 'não está mais disponível',
  no_wholesale_price: 'sem preço de atacado no momento',
  insufficient_stock: 'sem estoque suficiente — quantidade ajustada',
}

export function CarrinhoClient({ minimumOrderAmount, whatsappPhone, displayName }: Props) {
  const { items, updateQuantity, removeItem, totalDisplayValue } = useCart()
  const basePath = useWholesaleBasePath()
  const [sending, setSending] = useState(false)

  const missingForMinimum = Math.max(0, minimumOrderAmount - totalDisplayValue)
  const belowMinimum = missingForMinimum > 0

  async function handleCheckout() {
    if (items.length === 0 || belowMinimum) return

    setSending(true)
    try {
      const res = await fetch('/api/wholesale/cart/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.map((i) => ({ variationId: i.variationId, quantity: i.quantity })) }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error('Não foi possível validar o carrinho. Tente novamente.')
        return
      }

      const validation: { valid: boolean; items: ValidationItem[] } = json
      const byVariation = new Map(validation.items.map((v) => [v.variationId, v]))

      if (!validation.valid) {
        // Preço/estoque mudaram desde que o item foi adicionado (seção 22
        // do pedido) — ajusta o carrinho pro estado real e pede pra
        // revisar antes de tentar de novo, nunca envia pro WhatsApp com
        // dado desatualizado.
        for (const item of items) {
          const result = byVariation.get(item.variationId)
          if (!result) continue
          if (!result.ok) {
            if (result.reason === 'insufficient_stock' && result.availableQuantity > 0) {
              updateQuantity(item.variationId, result.availableQuantity)
            } else {
              removeItem(item.variationId)
            }
            toast.error(`${item.productName}${item.attributes ? ` (${item.attributes})` : ''}: ${REASON_LABEL[result.reason]}.`)
          }
        }
        return
      }

      const whatsappItems = items.map((item) => {
        const result = byVariation.get(item.variationId)
        return {
          productName: item.productName,
          attributes: item.attributes,
          quantity: item.quantity,
          unitPrice: (result?.ok ? result.price : item.displayPrice),
        }
      })

      const order = buildWhatsAppOrderMessage(whatsappItems, whatsappPhone, displayName)
      if (!order) {
        toast.error('WhatsApp não configurado. Entre em contato pelos outros canais.')
        return
      }

      trackInitiateCheckout({
        contentIds: items.map((i) => String(i.variationId)),
        value: order.totalValue,
        numItems: order.totalUnits,
      })

      window.open(order.url, '_blank', 'noopener,noreferrer')
    } catch {
      toast.error('Erro de rede ao validar o carrinho.')
    } finally {
      setSending(false)
    }
  }

  if (items.length === 0) {
    return (
      <div className="py-16 text-center space-y-3">
        <ShoppingBag className="w-10 h-10 text-gray-300 mx-auto" />
        <p className="text-gray-500">Seu carrinho está vazio.</p>
        <Link href={wholesaleHref(basePath, '/')} className="inline-block text-sm text-gray-900 font-medium hover:underline">
          Ver catálogo
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-xl font-semibold text-gray-900">Carrinho</h1>

      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.variationId} className="flex gap-3 py-3 border-b border-gray-100">
            <div className="w-16 h-16 rounded-lg bg-gray-50 flex items-center justify-center overflow-hidden shrink-0">
              {item.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.imageUrl} alt={item.productName} className="w-full h-full object-cover" />
              ) : (
                <ImageOff className="w-5 h-5 text-gray-300" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-800 truncate">{item.productName}</p>
              {item.attributes && <p className="text-xs text-gray-400">{item.attributes}</p>}
              <p className="text-sm font-semibold text-gray-900 mt-1">{formatCurrency(item.displayPrice)}</p>
            </div>
            <div className="flex flex-col items-end justify-between">
              <button onClick={() => removeItem(item.variationId)} className="text-gray-300 hover:text-red-500">
                <Trash2 className="w-4 h-4" />
              </button>
              <div className="flex items-center border border-gray-200 rounded-lg">
                <button onClick={() => updateQuantity(item.variationId, item.quantity - 1)} className="p-1.5 text-gray-500 hover:text-gray-900">
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <span className="w-8 text-center text-xs font-medium tabular-nums">{item.quantity}</span>
                <button onClick={() => updateQuantity(item.variationId, item.quantity + 1)} className="p-1.5 text-gray-500 hover:text-gray-900">
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Subtotal estimado</span>
          <span className="font-semibold text-gray-900">{formatCurrency(totalDisplayValue)}</span>
        </div>

        {belowMinimum ? (
          <p className="text-sm text-amber-600 font-medium">
            Faltam {formatCurrency(missingForMinimum)} para atingir o pedido mínimo de {formatCurrency(minimumOrderAmount)}.
          </p>
        ) : (
          <p className="text-xs text-gray-400">
            O valor final é sempre conferido no envio do pedido, com preço e disponibilidade atuais.
          </p>
        )}

        <button
          onClick={handleCheckout}
          disabled={sending || belowMinimum}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-full bg-[#25D366] text-white text-sm font-medium hover:brightness-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <MessageCircle className="w-4 h-4" />
          {sending ? 'Verificando...' : 'Enviar pedido pelo WhatsApp'}
        </button>
      </div>
    </div>
  )
}
