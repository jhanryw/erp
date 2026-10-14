'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'

interface Props {
  /** Link wa.me já construído NO SERVIDOR com o número comercial normalizado e a mensagem codificada. */
  url: string
  enabledDesktop: boolean
  enabledMobile: boolean
}

/** Carrinho: controles de quantidade/remover/finalizar por toda a tela → no celular o botão não é exibido ali. */
const HIDDEN_ON_MOBILE_PATHS = /(^|\/)carrinho(\/|$)/
/** Produto: o botão aparece, mas recua (some) enquanto estiver sobre qualquer controle interativo do conteúdo. */
const DYNAMIC_PATHS = /(^|\/)produto(\/|$)/
const INTERACTIVE = 'main button, main input, main select, main textarea, main a[href], main [role="button"]'

function overlapsInteractive(self: HTMLElement): boolean {
  const f = self.getBoundingClientRect()
  // margem de 8px: o dedo precisa de folga ao redor do botão
  const [l, r, t, b] = [f.left - 8, f.right + 8, f.top - 8, f.bottom + 8]
  const nodes = document.querySelectorAll<HTMLElement>(INTERACTIVE)
  for (const el of Array.from(nodes)) {
    if (self.contains(el)) continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    if (rect.right > l && rect.left < r && rect.bottom > t && rect.top < b) return true
  }
  return false
}

/**
 * Botão flutuante de atendimento. Usa o glifo OFICIAL do WhatsApp (public/brand/whatsapp, arquivo local da Meta)
 * sobre círculo #25D366. Respeita safe areas. No celular fica oculto em /carrinho e, em /produto, recua enquanto sobrepõe
 * qualquer controle (quantidade, adicionar, variações) e volta ao sair de cima deles; no desktop aparece sempre na margem inferior direita.
 * É só atendimento: não substitui o botão de finalização do pedido (que envia o pedido completo).
 */
export function FloatingWhatsApp({ url, enabledDesktop, enabledMobile }: Props) {
  const pathname = usePathname() ?? ''
  const ref = useRef<HTMLAnchorElement>(null)
  const [covering, setCovering] = useState(false)
  const dynamic = DYNAMIC_PATHS.test(pathname)

  useEffect(() => {
    setCovering(false)
    const el = ref.current
    if (!dynamic || !el) return
    let raf = 0
    const check = () => {
      raf = 0
      // só vale no celular: no desktop o botão fica na margem, fora do conteúdo
      if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return
      if (getComputedStyle(el).display === 'none') return
      setCovering(overlapsInteractive(el))
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(check) }
    const delayed = () => { window.setTimeout(schedule, 120) }
    schedule()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    document.addEventListener('click', delayed)
    document.addEventListener('input', delayed)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('click', delayed)
      document.removeEventListener('input', delayed)
    }
  }, [dynamic, pathname])

  if (!enabledDesktop && !enabledMobile) return null

  const hideOnMobile = !enabledMobile || HIDDEN_ON_MOBILE_PATHS.test(pathname)
  const visibility = [
    hideOnMobile ? 'max-lg:hidden' : '',
    !enabledDesktop ? 'lg:hidden' : '',
  ].filter(Boolean).join(' ')

  return (
    <a
      ref={ref}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Falar com a loja no WhatsApp (abre em nova aba)"
      title="Falar com a loja no WhatsApp"
      data-floating-whatsapp
      className={`fixed z-30 flex h-14 w-14 items-center justify-center rounded-full bg-[#25D366] shadow-lg shadow-black/25 ring-1 ring-black/10 transition-transform hover:scale-105 active:scale-95 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-gray-900 max-lg:h-12 max-lg:w-12 ${visibility} ${covering ? 'max-lg:pointer-events-none max-lg:opacity-0' : ''}`}
      data-covering={covering ? 'true' : undefined}
      aria-hidden={covering ? true : undefined}
      tabIndex={covering ? -1 : undefined}
      style={{ right: 'max(16px, env(safe-area-inset-right))', bottom: 'max(16px, env(safe-area-inset-bottom))' }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/whatsapp/whatsapp-glyph-white.svg" alt="" width={32} height={32} className="h-8 w-8 max-lg:h-7 max-lg:w-7" draggable={false} />
    </a>
  )
}
