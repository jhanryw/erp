'use client'

import { useEffect, useRef, useState } from 'react'
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

function BannerImage({ banner, basePath, priority }: { banner: WholesaleBanner; basePath: string; priority: boolean }) {
  const href = bannerHref(basePath, banner)
  const isExternal = banner.link.type === 'url'
  const hasMobile = !!banner.mobileImageUrl
  const alt = banner.altText ?? banner.title ?? ''

  // Direção de arte com <picture>: o navegador baixa SÓ a imagem do seu breakpoint (nunca as duas),
  // ambas otimizadas pelo next/image. Sem imagem mobile, a desktop é recortada (object-cover) em 16:9.
  const common = { alt, fill: true, sizes: '100vw', quality: 80 } as const
  const { props: desktop } = getImageProps({ ...common, src: banner.imageUrl })
  const mobile = hasMobile ? getImageProps({ ...common, src: banner.mobileImageUrl as string }).props : null
  const { srcSet: desktopSrcSet, ...img } = desktop

  const showText = bannerHasText(banner)

  const slide = (
    <div
      className={`relative w-full overflow-hidden rounded-2xl bg-stone-100 sm:aspect-[3/1] ${hasMobile ? 'aspect-square' : 'aspect-[16/9]'}`}
    >
      <picture>
        {mobile && <source media="(max-width: 639px)" srcSet={mobile.srcSet} sizes="100vw" />}
        <source media="(min-width: 640px)" srcSet={desktopSrcSet} sizes="100vw" />
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        <img {...img} alt={alt} className="object-cover" fetchPriority={priority ? 'high' : undefined} loading={priority ? 'eager' : 'lazy'} />
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
      <BannerImage key={banners[index].id} banner={banners[index]} basePath={basePath} priority={index === 0} />

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
