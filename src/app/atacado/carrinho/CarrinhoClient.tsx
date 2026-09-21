'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Minus, Plus, Trash2, ImageOff, ShoppingBag, MessageCircle } from 'lucide-react'
import { formatCurrency } from '@/lib/utils/currency'
import { useCart, type CartItem } from '../_lib/CartContext'
import { useWholesaleBasePath } from '../_lib/WholesaleBasePathContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'
import { trackInitiateCheckout } from '@/lib/wholesale/metaPixel'
import { applyValidationToCart, type ValidationResponse } from '../_lib/cartSync'

interface Props {
  minimumOrderAmount: number
}

const CUSTOMER_KEY = 'santtorini_wholesale_customer_v1'

interface ConfirmedOrder { code: string; totalItems: number; subtotal: number; whatsappUrl: string }

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // Fallback (contexto não-seguro): UUID v4 via Math.random — suficiente como chave de idempotência.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

const signatureOf = (items: CartItem[]) => items.map((i) => `${i.variationId}:${i.quantity}`).join('|')

export function CarrinhoClient({ minimumOrderAmount }: Props) {
  const { items, updateQuantity, removeItem, syncItems, clear, ready, totalDisplayValue } = useCart()
  const basePath = useWholesaleBasePath()
  const [sending, setSending] = useState(false)
  const [checking, setChecking] = useState(false)
  // Totais calculados pelo SERVIDOR na última validação, amarrados à composição do
  // carrinho (variação:quantidade) — se o cliente mexer nas quantidades depois, volta
  // a mostrar a estimativa local até a próxima validação.
  const [serverSummary, setServerSummary] = useState<{ signature: string; summary: ValidationResponse['summary'] } | null>(null)
  const openedRef = useRef(false)

  // Dados do comprador (só nome e WhatsApp — sem login/cadastro). Lembrados no aparelho por conveniência.
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [confirmed, setConfirmed] = useState<ConfirmedOrder | null>(null)
  // A MESMA chave é reutilizada em retry/duplo clique da mesma tentativa; muda se itens ou dados mudarem.
  const attemptRef = useRef<{ signature: string; key: string } | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CUSTOMER_KEY)
      if (raw) {
        const saved = JSON.parse(raw)
        if (typeof saved?.name === 'string') setCustomerName(saved.name)
        if (typeof saved?.phone === 'string') setCustomerPhone(saved.phone)
      }
    } catch { /* sem localStorage: campos começam vazios */ }
  }, [])

  const useServer = serverSummary != null && serverSummary.signature === signatureOf(items)
  const minimum = useServer ? serverSummary.summary.minimumOrderAmount : minimumOrderAmount
  const cartTotal = useServer ? serverSummary.summary.subtotal : totalDisplayValue
  const missingForMinimum = useServer ? serverSummary.summary.missingForMinimum : Math.max(0, minimum - cartTotal)
  const belowMinimum = missingForMinimum > 0

  /** Chama a revalidação do servidor; `null` em falha (já avisa o cliente). */
  async function validateOnServer(current: CartItem[]): Promise<ValidationResponse | null> {
    try {
      const res = await fetch('/api/wholesale/cart/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: current.map((i) => ({ variationId: i.variationId, quantity: i.quantity })) }),
      })
      if (!res.ok) {
        toast.error('Não foi possível validar o carrinho. Tente novamente.')
        return null
      }
      return await res.json()
    } catch {
      toast.error('Erro de rede ao validar o carrinho.')
      return null
    }
  }

  /** Aplica a resposta do servidor ao carrinho, guarda os totais do servidor e avisa o que mudou. */
  function applyServerState(current: CartItem[], validation: ValidationResponse) {
    const applied = applyValidationToCart(current, validation)
    syncItems(() => applied.items)
    setServerSummary({ signature: signatureOf(applied.items), summary: validation.summary })
    applied.messages.slice(0, 5).forEach((message) => toast.info(message))
    return applied
  }

  // Revalida UMA vez ao abrir o carrinho (preço, estoque, produto removido do atacado).
  useEffect(() => {
    if (!ready || openedRef.current || items.length === 0) return
    openedRef.current = true
    setChecking(true)
    validateOnServer(items)
      .then((validation) => { if (validation) applyServerState(items, validation) })
      .finally(() => setChecking(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, items.length])

  async function handleCheckout() {
    if (items.length === 0 || belowMinimum || sending) return

    const name = customerName.trim()
    if (name.length < 2) { toast.error('Informe seu nome.'); return }
    if (customerPhone.replace(/\D/g, '').length < 10) { toast.error('Informe seu WhatsApp com DDD.'); return }

    const signature = `${signatureOf(items)}#${name}#${customerPhone.replace(/\D/g, '')}`
    if (attemptRef.current?.signature !== signature) attemptRef.current = { signature, key: newIdempotencyKey() }

    setSending(true)
    try {
      // O servidor revalida TUDO (preço, estoque, atacado, mínimo) e cria o pedido; o
      // navegador só manda id + quantidade e os dados de contato.
      const res = await fetch('/api/wholesale/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotency_key: attemptRef.current.key,
          customer: { name, phone: customerPhone },
          items: items.map((i) => ({ variation_id: i.variationId, quantity: i.quantity })),
        }),
      })
      const json = await res.json().catch(() => ({}))

      if (res.status === 409 && json.validation) {
        // Estoque/preço/disponibilidade mudou: atualiza o carrinho e o cliente confirma de novo.
        applyServerState(items, json.validation)
        toast.error('Alguns itens mudaram. Revise o carrinho e envie novamente.')
        return
      }
      if (res.status === 422 && json.error === 'below_minimum') {
        setServerSummary({
          signature: signatureOf(items),
          summary: { subtotal: json.currentTotal, minimumOrderAmount: json.minimumOrder, meetsMinimum: false, missingForMinimum: json.missingAmount },
        })
        toast.error(`Pedido mínimo de ${formatCurrency(json.minimumOrder)} não atingido. Faltam ${formatCurrency(json.missingAmount)}.`)
        return
      }
      if (!res.ok || !json.order || !json.whatsappUrl) {
        toast.error(typeof json.message === 'string' ? json.message : 'Não foi possível enviar o pedido. Tente novamente.')
        return
      }

      // Sucesso: pedido registrado. Só agora o evento de conversão dispara.
      try { localStorage.setItem(CUSTOMER_KEY, JSON.stringify({ name, phone: customerPhone })) } catch { /* ignora */ }
      trackInitiateCheckout({
        contentIds: items.map((i) => String(i.variationId)),
        value: json.order.subtotal,
        numItems: json.order.totalItems,
      })
      setConfirmed({ code: json.order.code, totalItems: json.order.totalItems, subtotal: json.order.subtotal, whatsappUrl: json.whatsappUrl })
      clear()
      attemptRef.current = null
      // Navegação da própria janela (não popup): confiável no Safari/iOS, Android e desktop.
      window.location.href = json.whatsappUrl
    } catch {
      toast.error('Erro de rede. Tente novamente — seu pedido não será duplicado.')
    } finally {
      setSending(false)
    }
  }

  if (confirmed) {
    return (
      <div className="py-12 max-w-md mx-auto text-center space-y-4">
        <MessageCircle className="w-10 h-10 text-[#25D366] mx-auto" />
        <h1 className="text-xl font-semibold text-gray-900">Pedido {confirmed.code} registrado</h1>
        <p className="text-sm text-gray-500">
          {confirmed.totalItems} peça{confirmed.totalItems !== 1 ? 's' : ''} · {formatCurrency(confirmed.subtotal)}.
          Envie a mensagem no WhatsApp para finalizarmos seu pedido.
        </p>
        <a href={confirmed.whatsappUrl} className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-[#25D366] text-white text-sm font-medium hover:brightness-95">
          <MessageCircle className="w-4 h-4" /> Abrir WhatsApp
        </a>
        <div>
          <Link href={wholesaleHref(basePath, '/')} className="text-sm text-gray-500 hover:underline">Voltar ao catálogo</Link>
        </div>
      </div>
    )
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
                <button
                  onClick={() => updateQuantity(item.variationId, item.quantity + 1)}
                  disabled={item.maxQuantity != null && item.quantity >= item.maxQuantity}
                  className="p-1.5 text-gray-500 hover:text-gray-900 disabled:opacity-30 disabled:hover:text-gray-500"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">{useServer ? 'Seu carrinho' : 'Subtotal estimado'}</span>
          <span className="font-semibold text-gray-900">{formatCurrency(cartTotal)}</span>
        </div>
        {minimum > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Pedido mínimo</span>
            <span className="text-gray-700">{formatCurrency(minimum)}</span>
          </div>
        )}

        {belowMinimum ? (
          <p className="text-sm text-amber-600 font-medium">
            Faltam {formatCurrency(missingForMinimum)} para atingir o pedido mínimo de {formatCurrency(minimum)}.
          </p>
        ) : (
          <p className="text-xs text-gray-400">
            {checking ? 'Atualizando preços e disponibilidade…' : 'O valor final é sempre conferido no envio do pedido, com preço e disponibilidade atuais.'}
          </p>
        )}

        <div className="grid gap-2 sm:grid-cols-2 pt-1">
          <input
            type="text" autoComplete="name" placeholder="Seu nome" value={customerName} maxLength={80}
            onChange={(e) => setCustomerName(e.target.value)}
            className="w-full px-3 py-2.5 rounded-lg border border-gray-200 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
          />
          <input
            type="tel" inputMode="tel" autoComplete="tel" placeholder="Seu WhatsApp (com DDD)" value={customerPhone} maxLength={20}
            onChange={(e) => setCustomerPhone(e.target.value)}
            className="w-full px-3 py-2.5 rounded-lg border border-gray-200 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
          />
        </div>

        <button
          onClick={handleCheckout}
          disabled={sending || checking || belowMinimum}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-full bg-[#25D366] text-white text-sm font-medium hover:brightness-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <MessageCircle className="w-4 h-4" />
          {sending ? 'Enviando pedido...' : checking ? 'Atualizando...' : 'Enviar pedido pelo WhatsApp'}
        </button>
      </div>
    </div>
  )
}
