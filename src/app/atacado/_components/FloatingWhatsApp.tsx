'use client'

import { usePathname } from 'next/navigation'

interface Props {
  /** Link wa.me já construído NO SERVIDOR com o número comercial normalizado e a mensagem codificada. */
  url: string
  enabledDesktop: boolean
  enabledMobile: boolean
}

/** Páginas com controles de compra (quantidade, remover, finalizar): no celular o botão não é exibido ali. */
const PURCHASE_PATHS = /(^|\/)(carrinho|produto)(\/|$)/

/**
 * Botão flutuante de atendimento. Usa o glifo OFICIAL do WhatsApp (public/brand/whatsapp, arquivo local da Meta)
 * sobre círculo #25D366. Respeita safe areas. No celular fica oculto em /carrinho e /produto para nunca cobrir
 * quantidade, remover ou finalizar; no desktop aparece sempre na margem inferior direita.
 * É só atendimento: não substitui o botão de finalização do pedido (que envia o pedido completo).
 */
export function FloatingWhatsApp({ url, enabledDesktop, enabledMobile }: Props) {
  const pathname = usePathname() ?? ''
  if (!enabledDesktop && !enabledMobile) return null

  const hideOnMobile = !enabledMobile || PURCHASE_PATHS.test(pathname)
  const visibility = [
    hideOnMobile ? 'max-lg:hidden' : '',
    !enabledDesktop ? 'lg:hidden' : '',
  ].filter(Boolean).join(' ')

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Falar com a loja no WhatsApp (abre em nova aba)"
      title="Falar com a loja no WhatsApp"
      data-floating-whatsapp
      className={`fixed z-30 flex h-14 w-14 items-center justify-center rounded-full bg-[#25D366] shadow-lg shadow-black/25 ring-1 ring-black/10 transition-transform hover:scale-105 active:scale-95 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-gray-900 max-lg:h-12 max-lg:w-12 ${visibility}`}
      style={{ right: 'max(16px, env(safe-area-inset-right))', bottom: 'max(16px, env(safe-area-inset-bottom))' }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/whatsapp/whatsapp-glyph-white.svg" alt="" width={32} height={32} className="h-8 w-8 max-lg:h-7 max-lg:w-7" draggable={false} />
    </a>
  )
}
