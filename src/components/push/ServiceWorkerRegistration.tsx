'use client'

import { useEffect } from 'react'

// Registra o service worker silenciosamente — sem UI, apenas efeito colateral.
// Colocado no layout raiz para garantir registro em todas as páginas.
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator)) return

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((err) => console.error('[SW] Falha ao registrar service worker:', err))
  }, [])

  return null
}
