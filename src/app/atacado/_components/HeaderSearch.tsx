'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Search } from 'lucide-react'
import { useWholesaleBasePath } from '../_lib/WholesaleBasePathContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'

function SearchForm({ defaultValue }: { defaultValue: string }) {
  const basePath = useWholesaleBasePath()
  return (
    // GET para a home: a busca é sempre global (limpa categoria/página) e cai direto na lista de produtos.
    <form method="GET" action={`${wholesaleHref(basePath, '/')}#produtos`} role="search" className="relative w-full">
      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
      <input
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder="Buscar produtos..."
        aria-label="Buscar produtos"
        enterKeyHint="search"
        className="w-full rounded-full border border-gray-500 bg-white py-2.5 pl-10 pr-4 text-sm text-gray-900 placeholder:text-gray-500 focus:border-gray-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-gray-900/10"
      />
    </form>
  )
}

function SearchWithParams() {
  const params = useSearchParams()
  return <SearchForm defaultValue={params.get('q') ?? ''} />
}

export function HeaderSearch() {
  return (
    <Suspense fallback={<SearchForm defaultValue="" />}>
      <SearchWithParams />
    </Suspense>
  )
}
