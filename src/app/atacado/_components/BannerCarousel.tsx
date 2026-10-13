'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { getImageProps } from 'next/image'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useWholesaleBasePath } from '../_lib/WholesaleBasePathContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'
import type { WholesaleBanner } from '@/services/wholesale/banners'

const AUTOPLAY_MS = 6000

function bannerHref(basePath: string, banner: WholesaleBanner): string | null {
  switch (banner.link.type) {
    case 'category': return banner.link.categorySlug ? `${wholesaleHref(basePath, '/')}?categoria=${encodeURIComponent(banner.link.categorySlug)}` : null
    case 'product': return banner.link.productId ? wholesaleHref(basePath, `/produto/${banner.link.productId}`) : null
    case 'url': return banner.link.url ?? null
    default: return null
  }
}

/** Só mostra textos quando o banner pede (`showText`) E há algo para mostrar. */
export function bannerHasText(banner: WholesaleBanner): boolean {
  return banner.showText && !!(banner.title || banner.subtitle || banner.ctaLabel)
}

const FALLBACK_DESKTOP = '3 / 1'

/**
 * Proporções (CSS `aspect-ratio`) do contêiner, por breakpoint.
 *  - desktop: proporção real da imagem desktop (reserva 3:1 se as dimensões não puderam ser lidas);
 *  - celular: proporção real da imagem mobile, se existir; senão a MESMA arte desktop, inteira, na sua proporção
 *    original. Exceção: foto de fundo com texto do site por cima fica em 16:9 (o texto precisa de altura).
 */
export function bannerRatios(banner: WholesaleBanner): { desktop: string; mobile: string } {
  const ratio = (w: number | null, h: number | null) => (w && h ? `${w} / ${h}` : null)
  const desktop = ratio(banner.imageWidth, banner.imageHeight) ?? FALLBACK_DESKTOP
  const mobileOwn = banner.mobileImageUrl ? ratio(banner.mobileImageWidth, banner.mobileImageHeight) : null
  if (mobileOwn) return { desktop, mobile: mobileOwn }
  if (banner.mobileImageUrl) return { desktop, mobile: '1 / 1' } // mobile cadastrada, dimensão ilegível
  return { desktop, mobile: bannerHasText(banner) ? '16 / 9' : desktop }
}

function BannerImage({ banner, basePath, priority, measureRef }: { banner: WholesaleBanner; basePath: string; priority: boolean; measureRef?: React.Ref<HTMLDivElement> }) {
  const href = bannerHref(basePath, banner)
  const isExternal = banner.link.type === 'url'
  const hasMobile = !!banner.mobileImageUrl
  const alt = banner.altText ?? banner.title ?? ''

  // Direção de arte com <picture>: o navegador baixa SÓ a imagem do seu breakpoint (nunca as duas),
  // ambas otimizadas pelo next/image (via /_next/image, com sharp em produção).
  //
  // PROPORÇÃO: o contêiner acompanha a proporção REAL da arte (largura 100%, altura automática). A imagem
  // preenche exatamente o contêiner: sem barras laterais, sem recorte e sem distorção — e, como a proporção é
  // conhecida antes do carregamento, sem salto de layout (CLS). Nada de proporção fixa diferente da imagem.
  const common = { alt, fill: true, sizes: '(min-width: 1184px) 1152px, 100vw', quality: 80 } as const
  const { props: desktop } = getImageProps({ ...common, src: banner.imageUrl })
  const mobile = hasMobile ? getImageProps({ ...common, src: banner.mobileImageUrl as string }).props : null

  const showText = bannerHasText(banner)
  const ratios = bannerRatios(banner)
  // Arte pronta (texto na imagem): `contain` por segurança — com a proporção exata equivale a preencher.
  // Foto de fundo com texto do site por cima: `cover` (recorte nas bordas não remove informação).
  const fit = showText ? 'object-cover' : 'object-contain'

  const slide = (
    <div
      ref={measureRef}
      className="relative w-full overflow-hidden rounded-2xl aspect-[var(--banner-ar-m)] sm:aspect-[var(--banner-ar-d)]"
      style={{ '--banner-ar-m': ratios.mobile, '--banner-ar-d': ratios.desktop } as React.CSSProperties}
    >
      {/*
        A <img> carrega o srcSet COMPLETO da desktop: sem imagem mobile (ou em telas ≥640 px) o navegador escolhe
        a largura certa para a tela. Com imagem mobile, o <source> de ≤639 px a substitui — só uma é baixada.
      */}
      <picture>
        {mobile && <source media="(max-width: 639px)" srcSet={mobile.srcSet} sizes={common.sizes} />}
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        <img {...desktop} alt={alt} className={fit} fetchPriority={priority ? 'high' : undefined} loading={priority ? 'eager' : 'lazy'} />
      </picture>

      {showText && (
        <>
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/15 to-transparent sm:bg-gradient-to-r sm:from-black/55 sm:via-black/10 sm:to-transparent" />
          <div className="absolute inset-x-0 bottom-0 sm:inset-y-0 sm:right-auto sm:flex sm:items-center p-5 sm:p-10 sm:max-w-[55%]">
            <div className="space-y-2 sm:space-y-3">
              {banner.title && <h2 className="font-serif text-2xl sm:text-4xl leading-tight text-white">{banner.title}</h2>}
              {banner.subtitle && <p className="text-sm sm:text-base text-white/90 leading-snug">{banner.subtitle}</p>}
              {banner.ctaLabel && href && (
                <span className="inline-block mt-1 rounded-full bg-white px-5 py-2.5 text-sm font-medium text-gray-900">
                  {banner.ctaLabel}
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )

  if (!href) return slide
  return isExternal
    ? <a href={href} target="_blank" rel="noopener noreferrer" aria-label={alt || banner.ctaLabel || undefined}>{slide}</a>
    : <Link href={href} aria-label={alt || banner.ctaLabel || undefined}>{slide}</Link>
}

export function BannerCarousel({ banners }: { banners: WholesaleBanner[] }) {
  const basePath = useWholesaleBasePath()
  const [index, setIndex] = useState(0)
  const touchStartX = useRef<number | null>(null)

  const multiple = banners.length > 1

  // Altura do slide atual: como cada arte tem a sua proporção, o contêiner anima de uma altura para outra
  // (sem salto brusco) e nunca deixa espaço vazio. Sem JS/antes da medição a altura é automática (sem CLS).
  const slideRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = slideRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    setHeight(el.getBoundingClientRect().height)
    const observer = new ResizeObserver(() => setHeight(el.getBoundingClientRect().height))
    observer.observe(el)
    return () => observer.disconnect()
  }, [index, multiple])

  useEffect(() => {
    if (!multiple) return
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const timer = setInterval(() => setIndex((i) => (i + 1) % banners.length), AUTOPLAY_MS)
    return () => clearInterval(timer)
  }, [multiple, banners.length])

  if (banners.length === 0) return null

  function go(delta: number) {
    setIndex((i) => (i + delta + banners.length) % banners.length)
  }

  if (!multiple) {
    return <BannerImage banner={banners[0]} basePath={basePath} priority />
  }

  return (
    <div
      className="relative"
      onTouchStart={(e) => { touchStartX.current = e.touches[0].clientX }}
      onTouchEnd={(e) => {
        if (touchStartX.current == null) return
        const delta = e.changedTouches[0].clientX - touchStartX.current
        if (Math.abs(delta) > 40) go(delta > 0 ? -1 : 1)
        touchStartX.current = null
      }}
    >
      <div
        className="overflow-hidden rounded-2xl transition-[height] duration-300 ease-out motion-reduce:transition-none"
        style={height != null ? { height } : undefined}
      >
        <BannerImage key={banners[index].id} banner={banners[index]} basePath={basePath} priority={index === 0} measureRef={slideRef} />
      </div>

      <button
        onClick={() => go(-1)}
        aria-label="Banner anterior"
        className="hidden sm:flex absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 items-center justify-center rounded-full bg-white/80 text-gray-700 hover:bg-white transition-colors"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      <button
        onClick={() => go(1)}
        aria-label="Próximo banner"
        className="hidden sm:flex absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 items-center justify-center rounded-full bg-white/80 text-gray-700 hover:bg-white transition-colors"
      >
        <ChevronRight className="w-4 h-4" />
      </button>

      <div className="flex justify-center gap-1.5 mt-2.5">
        {banners.map((b, i) => (
          <button
            key={b.id}
            onClick={() => setIndex(i)}
            aria-label={`Ir para banner ${i + 1}`}
            className={`h-1.5 rounded-full transition-all ${i === index ? 'w-5 bg-gray-900' : 'w-1.5 bg-gray-300'}`}
          />
        ))}
      </div>
    </div>
  )
}
