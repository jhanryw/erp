'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { LayoutGrid, X } from 'lucide-react'
import { useWholesaleBasePath } from '../_lib/WholesaleBasePathContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'
import type { WholesaleCategory } from '@/services/wholesale/catalog'

interface Props {
  categories: WholesaleCategory[]
  activeSlug: string | null
  /** Preservado ao trocar de categoria — nunca perde a busca em andamento. */
  search?: string
}

function categoryHref(basePath: string, search: string | undefined, slug: string | null): string {
  const params = new URLSearchParams()
  if (search) params.set('q', search)
  if (slug) params.set('categoria', slug)
  const qs = params.toString()
  return `${wholesaleHref(basePath, '/')}${qs ? `?${qs}` : ''}`
}

function CategoryLink({ href, label, active, onClick }: { href: string; label: string; active: boolean; onClick?: () => void }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={`block px-3 py-2 rounded-lg text-sm transition-colors ${
        active ? 'bg-gray-900 text-white font-medium' : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      {label}
    </Link>
  )
}

/** Botão + drawer de categorias — só mobile. Renderizado perto da busca (ver diagrama da seção 14 do pedido). */
export function CategoryMobileButton({ categories, activeSlug, search }: Props) {
  const basePath = useWholesaleBasePath()
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    if (!drawerOpen) return
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [drawerOpen])

  if (categories.length === 0) return null

  return (
    <div className="md:hidden">
      <button
        onClick={() => setDrawerOpen(true)}
        className="flex items-center gap-2 px-3.5 py-2 rounded-full border border-gray-200 text-sm text-gray-700 w-fit"
      >
        <LayoutGrid className="w-4 h-4" />
        {categories.find((c) => c.slug === activeSlug)?.name ?? 'Categorias'}
      </button>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex items-end">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawerOpen(false)} />
          <div className="relative w-full bg-white rounded-t-2xl max-h-[70vh] overflow-y-auto p-4 space-y-1">
            <div className="flex items-center justify-between pb-2">
              <h2 className="text-sm font-semibold text-gray-900">Categorias</h2>
              <button onClick={() => setDrawerOpen(false)} className="p-1 text-gray-400">
                <X className="w-5 h-5" />
              </button>
            </div>
            <CategoryLink href={categoryHref(basePath, search, null)} label="Todas" active={!activeSlug} onClick={() => setDrawerOpen(false)} />
            {categories.map((c) => (
              <CategoryLink key={c.slug} href={categoryHref(basePath, search, c.slug)} label={c.name} active={c.slug === activeSlug} onClick={() => setDrawerOpen(false)} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Sidebar sticky de categorias — só desktop, ao lado da grade de produtos. */
export function CategorySidebar({ categories, activeSlug, search }: Props) {
  const basePath = useWholesaleBasePath()

  if (categories.length === 0) return null

  return (
    <aside className="hidden md:block w-48 shrink-0">
      <div className="sticky top-20 space-y-0.5">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide px-3 pb-2">Categorias</p>
        <CategoryLink href={categoryHref(basePath, search, null)} label="Todas" active={!activeSlug} />
        {categories.map((c) => (
          <CategoryLink key={c.slug} href={categoryHref(basePath, search, c.slug)} label={c.name} active={c.slug === activeSlug} />
        ))}
      </div>
    </aside>
  )
}
