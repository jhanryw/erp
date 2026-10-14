'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import { useWholesaleBasePath } from '../_lib/WholesaleBasePathContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'

export interface AnnouncementView {
  id: number
  message: string
  linkUrl: string | null
  backgroundColor: string
  textColor: string
}

interface Props {
  announcements: AnnouncementView[]
  /** Segundos entre mensagens (3–30). */
  intervalSeconds: number
}

/**
 * Barra de anúncios (topo, 100% da largura). Altura FIXA (sem CLS), renderizada já com a 1ª mensagem no HTML do servidor.
 * Várias mensagens: alterna sozinha, pausa ao passar o mouse/focar/tocar ou pelo botão Pausar (WCAG 2.2.2), e NÃO
 * alterna sozinha com `prefers-reduced-motion`. Link opcional por mensagem; texto sempre como TEXTO (React escapa).
 */
export function AnnouncementBar({ announcements, intervalSeconds }: Props) {
  const basePath = useWholesaleBasePath()
  const [index, setIndex] = useState(0)
  const [hovering, setHovering] = useState(false)
  const [focused, setFocused] = useState(false)
  const [userPaused, setUserPaused] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)

  const count = announcements.length
  const multiple = count > 1

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(query.matches)
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [])

  const paused = hovering || focused || userPaused || reducedMotion

  useEffect(() => {
    if (!multiple || paused) return
    const timer = setInterval(() => setIndex((i) => (i + 1) % count), Math.min(30, Math.max(3, intervalSeconds)) * 1000)
    return () => clearInterval(timer)
  }, [multiple, paused, count, intervalSeconds])

  if (count === 0) return null

  const current = announcements[Math.min(index, count - 1)]
  const go = (delta: number) => setIndex((i) => (i + delta + count) % count)

  const isExternal = !!current.linkUrl && /^https?:\/\//i.test(current.linkUrl)
  const text = <span className="line-clamp-2 text-center text-[12px] leading-tight sm:line-clamp-1 sm:text-sm">{current.message}</span>
  const linkClass = 'flex min-w-0 flex-1 items-center justify-center underline-offset-2 hover:underline'

  return (
    <div
      role="region"
      aria-label="Avisos da loja"
      className="w-full"
      style={{ backgroundColor: current.backgroundColor, color: current.textColor }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onTouchStart={() => setHovering(true)}
      onTouchEnd={() => setTimeout(() => setHovering(false), 4000)}
    >
      <div className="mx-auto flex h-10 max-w-6xl items-center gap-1 px-2 sm:h-9 sm:px-4">
        {multiple && (
          <button type="button" aria-label="Aviso anterior" onClick={() => go(-1)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full opacity-90 hover:opacity-100">
            <ChevronLeft aria-hidden className="h-4 w-4" />
          </button>
        )}

        {current.linkUrl ? (
          isExternal ? (
            <a href={current.linkUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>{text}</a>
          ) : (
            <Link href={wholesaleHref(basePath, current.linkUrl)} className={linkClass}>{text}</Link>
          )
        ) : (
          <p className="flex min-w-0 flex-1 items-center justify-center">{text}</p>
        )}

        {multiple && (
          <>
            <button type="button" aria-label="Próximo aviso" onClick={() => go(1)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full opacity-90 hover:opacity-100">
              <ChevronRight aria-hidden className="h-4 w-4" />
            </button>
            {!reducedMotion && (
              <button
                type="button"
                aria-label={userPaused ? 'Retomar a troca automática dos avisos' : 'Pausar a troca automática dos avisos'}
                aria-pressed={userPaused}
                onClick={() => setUserPaused((v) => !v)}
                className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-full opacity-90 hover:opacity-100 sm:flex"
              >
                {userPaused ? <Play aria-hidden className="h-3.5 w-3.5" /> : <Pause aria-hidden className="h-3.5 w-3.5" />}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
