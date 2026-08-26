'use client'

/**
 * Injeta o script do Meta Pixel SÓ QUANDO habilitado e com Pixel ID válido
 * (seção 16 do pedido) — nunca carrega o script à toa. Dispara PageView
 * (deduplicado por pathname, ver metaPixel.ts) no mount e em toda troca de
 * rota client-side dentro do catálogo.
 */

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { trackPageView } from '@/lib/wholesale/metaPixel'

export function MetaPixelLoader({ pixelEnabled, pixelId }: { pixelEnabled: boolean; pixelId: string | null }) {
  const pathname = usePathname()

  useEffect(() => {
    if (!pixelEnabled || !pixelId) return

    if (typeof window.fbq !== 'function') {
      // Bootstrap oficial do Meta Pixel (fbevents.js) — injetado uma única
      // vez por aba (guarda `f.fbq` já presente, idêntico ao snippet
      // padrão do Meta Business).
      ;(function (f: Window, b: Document, e: string, v: string) {
        if (f.fbq) return
        const n = function (this: unknown, ...args: unknown[]) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const self = n as any
          self.callMethod ? self.callMethod.apply(self, args) : self.queue.push(args)
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nAny = n as any
        f.fbq = n
        nAny.push = n
        nAny.loaded = true
        nAny.version = '2.0'
        nAny.queue = []
        const t = b.createElement(e) as HTMLScriptElement
        t.async = true
        t.src = v
        const s = b.getElementsByTagName(e)[0]
        s.parentNode?.insertBefore(t, s)
      })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js')

      window.fbq!('init', pixelId)
    }

    trackPageView(pathname)
  }, [pixelEnabled, pixelId, pathname])

  return null
}
