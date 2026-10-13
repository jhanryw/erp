'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Trash2, ImageOff, ShoppingBag, MessageCircle } from 'lucide-react'
import { formatCurrency } from '@/lib/utils/currency'
import { useCart, type CartItem } from '../_lib/CartContext'
import { useWholesaleBasePath } from '../_lib/WholesaleBasePathContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'
import { trackInitiateCheckout } from '@/lib/wholesale/metaPixel'
import { applyValidationToCart, type ValidationResponse } from '../_lib/cartSync'
import { AddAlsoSection } from './AddAlsoSection'
import { CatalogImage } from '../_components/CatalogImage'
import { QuantityStepper } from '../_components/QuantityStepper'

interface Props {
  minimumOrderAmount: number
  /** Texto informativo configurável — NUNCA o valor do mínimo (esse vem de `minimumOrderAmount`). */
  minimumOrderNote?: string | null
  addAlsoTitle?: string
}

interface ConfirmedOrder { code: string; totalItems: number; subtotal: number; whatsappUrl: string }

/** Pedido NÃO registrado (registro temporariamente limitado): o cliente segue pelo WhatsApp e a loja confirma. */
interface PendingFallback { whatsappUrl: string; message: string; totalItems: number; subtotal: number }

/** Só segue link wa.me do próprio servidor — nunca uma URL arbitrária vinda da resposta. */
const isWhatsAppUrl = (value: unknown): value is string => typeof value === 'string' && value.startsWith('https://wa.me/')

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // Fallback (contexto não-seguro): UUID v4 via Math.random — suficiente como chave de idempotência.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

const signatureOf = (items: CartItem[]) => items.map((i) => `${i.variationId}:${i.quantity}`).join('|')

export function CarrinhoClient({ minimumOrderAmount, minimumOrderNote = null, addAlsoTitle }: Props) {
  const { items, adjustQuantity, removeItem, syncItems, clear, ready, totalDisplayValue } = useCart()
  const basePath = useWholesaleBasePath()
  const [sending, setSending] = useState(false)
  const [checking, setChecking] = useState(false)
  // Totais calculados pelo SERVIDOR na última validação, amarrados à composição do
  // carrinho (variação:quantidade) — se o cliente mexer nas quantidades depois, volta
  // a mostrar a estimativa local até a próxima validação.
  const [serverSummary, setServerSummary] = useState<{ signature: string; summary: ValidationResponse['summary'] } | null>(null)
  const openedRef = useRef(false)

  const [confirmed, setConfirmed] = useState<ConfirmedOrder | null>(null)
  const [pending, setPending] = useState<PendingFallback | null>(null)
  // A MESMA chave é reutilizada em retry/duplo clique da mesma tentativa; muda se os itens mudarem.
  const attemptRef = useRef<{ signature: string; key: string } | null>(null)

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
    setPending(null)

    // Sem nome/telefone no carrinho: o cliente é identificado pela própria conversa no WhatsApp.
    const signature = signatureOf(items)
    if (attemptRef.current?.signature !== signature) attemptRef.current = { signature, key: newIdempotencyKey() }

    setSending(true)
    try {
      // O servidor revalida TUDO (preço, estoque, atacado, mínimo) e cria o pedido; o
      // navegador só manda id + quantidade.
      const res = await fetch('/api/wholesale/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotency_key: attemptRef.current.key,
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
      if (res.status === 429 && json.error === 'rate_limited') {
        const fb = json.fallback
        if (fb && isWhatsAppUrl(fb.whatsappUrl) && typeof fb.message === 'string') {
          // Não é sucesso de registro: sem código, sem evento de conversão, carrinho preservado.
          setPending({ whatsappUrl: fb.whatsappUrl, message: fb.message, totalItems: Number(fb.totalItems) || 0, subtotal: Number(fb.subtotal) || 0 })
          return
        }
      }
      if (!res.ok || !json.order || !json.whatsappUrl) {
        toast.error(typeof json.message === 'string' ? json.message : 'Não foi possível enviar o pedido. Tente novamente.')
        return
      }

      // Sucesso: pedido registrado. Só agora o evento de conversão dispara.
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
        <MessageCircle className="w-10 h-10 text-[#0F7A3F] mx-auto" />
        <h1 className="text-xl font-semibold text-gray-900">Pedido {confirmed.code} registrado</h1>
        <p className="text-sm text-gray-500">
          {confirmed.totalItems} peça{confirmed.totalItems !== 1 ? 's' : ''} · {formatCurrency(confirmed.subtotal)}.
          Envie a mensagem no WhatsApp para finalizarmos seu pedido.
        </p>
        <a href={confirmed.whatsappUrl} className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-[#0F7A3F] text-white text-sm font-medium hover:brightness-95">
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
        <ShoppingBag aria-hidden className="w-10 h-10 text-gray-500 mx-auto" />
        <p className="text-gray-500">Seu carrinho está vazio.</p>
        <Link href={wholesaleHref(basePath, '/')} className="inline-block text-sm text-gray-900 font-medium hover:underline">
          Ver catálogo
        </Link>
      </div>
    )
  }

  const units = items.reduce((sum, i) => sum + i.quantity, 0)
  const progress = minimum > 0 ? Math.min(100, Math.round((cartTotal / minimum) * 100)) : 100
  const priceLine = (i: CartItem) => Math.round(i.displayPrice * i.quantity * 100) / 100

  return (
    <div className="space-y-10">
      <div className="space-y-6">
        <header className="flex items-baseline justify-between gap-3">
          <h1 className="font-serif text-2xl text-gray-900 sm:text-3xl">Meu carrinho</h1>
          <p className="text-sm text-gray-600">{units} {units === 1 ? 'peça' : 'peças'}</p>
        </header>

        {/* Desktop: lista (~65%) + resumo fixo (~35%). Mobile: lista → resumo → recomendações. */}
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,13fr)_minmax(0,7fr)] lg:gap-8">
          <section aria-label="Itens do carrinho" className="min-w-0">
            <ul className="divide-y divide-gray-200 overflow-hidden rounded-2xl border border-gray-200 bg-white">
              {items.map((item) => (
                <li key={item.variationId} className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2 p-3 sm:grid-cols-[88px_minmax(0,1fr)_auto] sm:items-center sm:gap-x-4 sm:p-4">
                  <div className="relative row-span-2 h-[72px] w-[72px] shrink-0 overflow-hidden rounded-lg bg-gray-50 sm:row-span-1 sm:h-[88px] sm:w-[88px]">
                    {item.imageUrl ? (
                      <CatalogImage src={item.imageUrl} alt={item.productName} sizes="88px" className="object-cover" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center"><ImageOff aria-hidden className="h-5 w-5 text-gray-500" /></span>
                    )}
                  </div>

                  <div className="min-w-0">
                    <p className="line-clamp-2 text-sm font-medium leading-snug text-gray-900">{item.productName}</p>
                    {item.attributes && <p className="mt-0.5 text-xs text-gray-600">{item.attributes}</p>}
                    <p className="mt-1 text-sm text-gray-700">{formatCurrency(item.displayPrice)} <span className="text-gray-500">cada</span></p>
                  </div>

                  <div className="col-span-2 flex items-center justify-between gap-3 sm:col-span-1 sm:justify-end sm:gap-5">
                    <QuantityStepper
                      value={item.quantity}
                      max={item.maxQuantity ?? 9999}
                      label={`${item.productName}${item.attributes ? ` ${item.attributes}` : ''}`}
                      onStep={(delta) => adjustQuantity(item.variationId, delta)}
                    />
                    <p className="min-w-[5.5rem] text-right text-base font-semibold tabular-nums text-gray-900">{formatCurrency(priceLine(item))}</p>
                    <button
                      type="button"
                      onClick={() => removeItem(item.variationId)}
                      aria-label={`Remover ${item.productName}`}
                      className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-600 transition-colors hover:bg-gray-100 hover:text-red-600"
                    >
                      <Trash2 aria-hidden className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm">
              <Link href={wholesaleHref(basePath, '/')} className="text-gray-700 underline underline-offset-2 hover:text-gray-900">Continuar comprando</Link>
            </p>
          </section>

          <aside aria-label="Resumo do pedido" className="lg:sticky lg:top-24">
            <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <h2 className="font-serif text-xl text-gray-900">Resumo do pedido</h2>

              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-gray-600">Peças</dt><dd className="font-medium text-gray-900">{units}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-600">{useServer ? 'Subtotal' : 'Subtotal estimado'}</dt><dd className="text-lg font-semibold tabular-nums text-gray-900">{formatCurrency(cartTotal)}</dd></div>
                {minimum > 0 && (
                  <div className="flex justify-between"><dt className="text-gray-600">Pedido mínimo</dt><dd className="font-medium tabular-nums text-gray-900">{formatCurrency(minimum)}</dd></div>
                )}
              </dl>

              {minimum > 0 && (
                <div className="space-y-2">
                  <div
                    role="progressbar"
                    aria-label="Progresso até o pedido mínimo"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress}
                    className="h-2.5 w-full overflow-hidden rounded-full bg-gray-200"
                  >
                    <div className={`h-full rounded-full transition-all duration-300 ${belowMinimum ? 'bg-brand' : 'bg-[#0F7A3F]'}`} style={{ width: `${progress}%` }} />
                  </div>
                  {belowMinimum ? (
                    <p className="text-sm font-medium text-amber-800">
                      Faltam {formatCurrency(missingForMinimum)} para atingir o pedido mínimo de {formatCurrency(minimum)}.
                    </p>
                  ) : (
                    <p className="text-sm font-medium text-[#0F7A3F]">Pedido mínimo atingido.</p>
                  )}
                </div>
              )}

              {minimum > 0 && minimumOrderNote && <p className="whitespace-pre-line text-xs text-gray-600">{minimumOrderNote}</p>}

              <button
                type="button"
                onClick={handleCheckout}
                disabled={sending || checking || belowMinimum}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-[#0F7A3F] py-3.5 text-sm font-semibold text-white transition-colors hover:bg-[#0c6634] active:bg-[#0a5a2d] disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-600"
              >
                <MessageCircle aria-hidden className="h-4 w-4" />
                {sending ? 'Enviando pedido...' : checking ? 'Atualizando...' : 'Finalizar pedido pelo WhatsApp'}
              </button>

              {pending && (
                <div role="alert" className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3.5">
                  <p className="text-sm font-semibold text-amber-900">Seu pedido ainda não foi registrado</p>
                  <p className="text-xs leading-relaxed text-amber-900">
                    Recebemos muitos pedidos agora e não conseguimos registrá-lo no sistema. Continue pelo WhatsApp: a mensagem já
                    leva seus produtos e a loja confirma o pedido com você.
                  </p>
                  <a
                    href={pending.whatsappUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex w-full items-center justify-center gap-2 rounded-full bg-[#0F7A3F] py-3 text-sm font-semibold text-white hover:bg-[#0c6634]"
                  >
                    <MessageCircle aria-hidden className="h-4 w-4" /> Continuar pelo WhatsApp
                  </a>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(pending.message)
                          toast.success('Mensagem copiada. Cole no WhatsApp da loja.')
                        } catch {
                          toast.error('Não foi possível copiar. Use o botão Continuar pelo WhatsApp.')
                        }
                      }}
                      className="flex-1 rounded-full border border-gray-500 py-2.5 text-xs font-medium text-gray-900 hover:bg-white"
                    >
                      Copiar mensagem
                    </button>
                    <button
                      type="button"
                      onClick={() => setPending(null)}
                      className="flex-1 rounded-full border border-gray-500 py-2.5 text-xs font-medium text-gray-900 hover:bg-white"
                    >
                      Tentar registrar de novo
                    </button>
                  </div>
                </div>
              )}

              <p className="text-xs leading-relaxed text-gray-600">
                {checking
                  ? 'Atualizando preços e disponibilidade…'
                  : 'Ao finalizar, abrimos o WhatsApp da loja com o seu pedido completo. Preço e disponibilidade são conferidos no envio.'}
              </p>
            </div>
          </aside>
        </div>
      </div>

      {/* Recomendações depois do carrinho e do resumo — nunca competem com a finalização. */}
      <AddAlsoSection title={addAlsoTitle} />
    </div>
  )
}
