'use client'

/**
 * Carrinho do site de atacado — Fase 8, seção 37 do pedido.
 *
 * Preserva `variationId`+`quantity`+dados de RENDERIZAÇÃO (nome/sku/preço
 * exibido no momento em que foi adicionado) — nunca a autoridade de
 * preço/disponibilidade final: o checkout SEMPRE revalida tudo no
 * servidor (`checkoutWholesaleCart`) antes de criar a venda. Se o preço
 * mudou entre adicionar ao carrinho e fechar o pedido, o valor aqui é só
 * o que foi mostrado ao cliente — o valor realmente cobrado é sempre o
 * resolvido no servidor no momento do checkout.
 *
 * Persistido em localStorage (por navegador, nunca por conta — reload
 * não perde o carrinho, mas não segue o cliente entre dispositivos nesta
 * primeira versão).
 */

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'

export interface CartItem {
  variationId: number
  productId: number
  productName: string
  sku: string
  attributes: string
  /** Preço exibido no momento em que foi adicionado — só pra renderização, nunca a fonte de verdade do checkout. */
  displayPrice: number
  quantity: number
  imageUrl: string | null
}

interface CartContextValue {
  items: CartItem[]
  addItem: (item: Omit<CartItem, 'quantity'>, quantity: number) => void
  updateQuantity: (variationId: number, quantity: number) => void
  removeItem: (variationId: number) => void
  clear: () => void
  totalItems: number
  totalDisplayValue: number
}

const CartContext = createContext<CartContextValue | null>(null)
const STORAGE_KEY = 'santtorini_wholesale_cart_v1'

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) setItems(JSON.parse(raw))
    } catch { /* localStorage indisponível — carrinho começa vazio */ }
    setLoaded(true)
  }, [])

  useEffect(() => {
    if (!loaded) return
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)) } catch { /* ignora falha de storage */ }
  }, [items, loaded])

  const addItem = useCallback((item: Omit<CartItem, 'quantity'>, quantity: number) => {
    setItems((prev) => {
      const existing = prev.find((i) => i.variationId === item.variationId)
      if (existing) {
        return prev.map((i) => i.variationId === item.variationId ? { ...i, quantity: i.quantity + quantity } : i)
      }
      return [...prev, { ...item, quantity }]
    })
  }, [])

  const updateQuantity = useCallback((variationId: number, quantity: number) => {
    setItems((prev) => quantity <= 0
      ? prev.filter((i) => i.variationId !== variationId)
      : prev.map((i) => i.variationId === variationId ? { ...i, quantity } : i))
  }, [])

  const removeItem = useCallback((variationId: number) => {
    setItems((prev) => prev.filter((i) => i.variationId !== variationId))
  }, [])

  const clear = useCallback(() => setItems([]), [])

  const totalItems = items.reduce((s, i) => s + i.quantity, 0)
  const totalDisplayValue = items.reduce((s, i) => s + i.quantity * i.displayPrice, 0)

  return (
    <CartContext.Provider value={{ items, addItem, updateQuantity, removeItem, clear, totalItems, totalDisplayValue }}>
      {children}
    </CartContext.Provider>
  )
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart precisa estar dentro de <CartProvider>')
  return ctx
}
