'use client'

/**
 * Meta Pixel do catálogo de atacado — ÚNICO lugar do projeto que chama
 * `fbq()` (seção 16 do pedido: "não espalhar chamadas fbq() arbitrariamente
 * pelos componentes"). Todo componente que precisa disparar um evento
 * importa uma função daqui, nunca `window.fbq` direto.
 *
 * Cada função é um no-op seguro se o Pixel não foi carregado (desabilitado
 * na config, sem Pixel ID, ou script ainda não injetado) — nunca lança erro
 * nem quebra a navegação do catálogo por causa de tracking.
 */

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void
  }
}

function isPixelReady(): boolean {
  return typeof window !== 'undefined' && typeof window.fbq === 'function'
}

// Dedupe de PageView — evita disparo duplicado quando o efeito de troca de
// rota roda mais de uma vez para o MESMO pathname (StrictMode em dev,
// re-render). Módulo é client-only (import 'use client' no topo), estado
// por aba do navegador — nunca compartilhado entre usuários.
let lastPageViewPath: string | null = null

export function trackPageView(pathname: string): void {
  if (!isPixelReady()) return
  if (lastPageViewPath === pathname) return
  lastPageViewPath = pathname
  window.fbq!('track', 'PageView')
}

export interface ViewContentParams {
  contentId: string
  contentName: string
  value: number
}

export function trackViewContent(params: ViewContentParams): void {
  if (!isPixelReady()) return
  window.fbq!('track', 'ViewContent', {
    content_ids: [params.contentId],
    content_name: params.contentName,
    content_type: 'product',
    value: params.value,
    currency: 'BRL',
  })
}

export interface AddToCartParams {
  contentId: string
  contentName: string
  value: number
  quantity: number
}

export function trackAddToCart(params: AddToCartParams): void {
  if (!isPixelReady()) return
  window.fbq!('track', 'AddToCart', {
    content_ids: [params.contentId],
    content_name: params.contentName,
    content_type: 'product',
    value: params.value,
    quantity: params.quantity,
    currency: 'BRL',
  })
}

export interface InitiateCheckoutParams {
  contentIds: string[]
  value: number
  numItems: number
}

// Disparado SÓ ao clicar "Enviar pedido pelo WhatsApp" com carrinho válido
// — nunca ao adicionar item ao carrinho (seção 16 do pedido: representa o
// início real da conversão, não uma intenção prematura).
export function trackInitiateCheckout(params: InitiateCheckoutParams): void {
  if (!isPixelReady()) return
  window.fbq!('track', 'InitiateCheckout', {
    content_ids: params.contentIds,
    value: params.value,
    num_items: params.numItems,
    currency: 'BRL',
  })
}

/** Só para testes — reseta o dedupe de PageView entre casos. */
export function __resetMetaPixelDedupeForTests(): void {
  lastPageViewPath = null
}
