'use client'

import { useEffect } from 'react'

export function PrintTrigger() {
  useEffect(() => {
    // Pequeno delay para o CSS carregar antes de abrir o diálogo
    const t = setTimeout(() => window.print(), 600)
    return () => clearTimeout(t)
  }, [])
  return null
}
