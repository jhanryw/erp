'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
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

function BannerImage({ banner, basePath }: { banner: WholesaleBanner; basePath: string }) {
  const href = bannerHref(basePath, banner)
  const isExternal = banner.link.type === 'url'

  const img = (
    // aspect-ratio fixo + object-cover: crop previsível em qualquer tamanho de tela (seção 21 do pedido), sem altura fixa gigante.
    <div className="relative w-full aspect-[21/9] sm:aspect-[3/1] overflow-hidden rounded-xl bg-gray-100">
      <Image src={banner.imageUrl} alt={banner.altText ?? ''} fill className="object-cover" priority />
    </div>
  )

  if (!href) return img
  return isExternal
    ? <a href={href} target="_blank" rel="noopener noreferrer">{img}</a>
    : <Link href={href}>{img}</Link>
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
    return <BannerImage banner={banners[0]} basePath={basePath} />
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
      <BannerImage banner={banners[index]} basePath={basePath} />

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
