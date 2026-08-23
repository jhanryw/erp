'use client'

import { useEffect } from 'react'

/**
 * Dispara window.print() automaticamente quando a página termina de
 * renderizar — nunca antes. O QR é SVG inline no HTML inicial (Server
 * Component, sem <img> carregando de rede), então não há race de imagem
 * assíncrona; mesmo assim, espera sinais reais de prontidão em vez de um
 * timeout fixo (que poderia disparar cedo demais numa máquina lenta, ou
 * atrasar à toa numa rápida):
 *   1. window 'load' — página e eventuais sub-recursos carregados.
 *   2. document.fonts.ready — fontes web (se houver) aplicadas.
 *   3. dois requestAnimationFrame — garante que o navegador já pintou o
 *      frame com o layout final antes de abrir o diálogo de impressão.
 */
export function PrintTrigger() {
  useEffect(() => {
    let cancelled = false

    async function waitUntilReadyThenPrint() {
      if (document.readyState !== 'complete') {
        await new Promise<void>((resolve) => {
          window.addEventListener('load', () => resolve(), { once: true })
        })
      }

      const fonts = (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts
      if (fonts?.ready) {
        try {
          await fonts.ready
        } catch {
          // Sem suporte/erro — segue sem travar a impressão por causa disso.
        }
      }

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })

      if (!cancelled) window.print()
    }

    waitUntilReadyThenPrint()
    return () => { cancelled = true }
  }, [])

  return null
}
