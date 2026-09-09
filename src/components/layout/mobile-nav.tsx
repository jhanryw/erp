'use client'

import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { usePathname } from 'next/navigation'
import { Menu } from 'lucide-react'
import { Sidebar } from '@/components/layout/sidebar'

/** Hambúrguer + drawer off-canvas mobile — reutiliza o mesmo Sidebar do desktop. */
export function MobileNav() {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const pathname = usePathname()

  useEffect(() => setMounted(true), [])

  // Fecha o drawer ao navegar para outra rota
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  // Bloquear scroll do body quando o drawer está aberto
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  const drawer = open && (
    <div className="fixed inset-0 z-50 lg:hidden">
      {/* Overlay escuro — clique fora para fechar */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => setOpen(false)}
      />
      {/* Painel off-canvas — 85vw, máximo 300px, respeitando safe-area do iOS */}
      <div
        className="absolute left-0 top-0 bottom-0 w-[85%] max-w-[300px] animate-slide-in-left"
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        <Sidebar
          className="w-full h-full shadow-elevated"
          onClose={() => setOpen(false)}
          onNavigate={() => setOpen(false)}
        />
      </div>
    </div>
  )

  return (
    <>
      {/* Hamburger — área de toque mínima 44px */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Abrir menu"
        className="flex items-center justify-center w-11 h-11 rounded-xl text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors lg:hidden"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/*
        Renderizado via portal direto em document.body: o header (Topbar) usa
        backdrop-blur, e um ancestral com backdrop-filter/filter/transform vira
        "containing block" de elementos fixed — sem o portal, este drawer ficava
        confinado à altura do próprio header (~55px) em vez de cobrir a tela.
      */}
      {mounted && drawer ? createPortal(drawer, document.body) : null}
    </>
  )
}
