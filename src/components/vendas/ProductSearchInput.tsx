'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Search, Loader2 } from 'lucide-react'
import { useDebounce } from '@/hooks/useDebounce'
import { useQuery } from '@tanstack/react-query'
import { formatCurrency } from '@/lib/utils/currency'
import type { ProductSearchItem } from '@/app/api/produtos/buscar/route'

export type { ProductSearchItem }

interface Props {
  onSelect: (item: ProductSearchItem) => void
  disabled?: boolean
}

export function ProductSearchInput({ onSelect, disabled }: Props) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const debouncedQuery = useDebounce(query, 300)

  const { data, isFetching, isError } = useQuery({
    queryKey: ['produtos-buscar', debouncedQuery],
    queryFn: async () => {
      const res = await fetch(`/api/produtos/buscar?q=${encodeURIComponent(debouncedQuery)}`)
      if (!res.ok) throw new Error('Erro ao buscar produtos')
      const json = await res.json()
      return json.items as ProductSearchItem[]
    },
    enabled: debouncedQuery.length >= 2,
    staleTime: 30_000,
  })

  const items = data ?? []

  // Sync open state with results
  useEffect(() => {
    if (debouncedQuery.length >= 2) {
      setOpen(true)
      setCursor(-1)
    } else {
      setOpen(false)
    }
  }, [debouncedQuery])

  const handleSelect = useCallback(
    (item: ProductSearchItem) => {
      onSelect(item)
      setQuery('')
      setOpen(false)
      setCursor(-1)
      inputRef.current?.focus()
    },
    [onSelect],
  )

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = cursor >= 0 ? items[cursor] : items[0]
      if (target) handleSelect(target)
    } else if (e.key === 'Escape') {
      setOpen(false)
      setCursor(-1)
    }
  }

  // Scroll cursor item into view
  useEffect(() => {
    if (cursor < 0 || !listRef.current) return
    const el = listRef.current.children[cursor] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
        {isFetching && (
          <Loader2 className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted animate-spin" />
        )}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (debouncedQuery.length >= 2) setOpen(true) }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          disabled={disabled}
          autoComplete="off"
          placeholder="Buscar por nome ou SKU…"
          className="w-full rounded-lg border border-border bg-bg-input py-2 pl-9 pr-9 text-sm text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none disabled:opacity-50"
        />
      </div>

      {open && (
        <ul
          ref={listRef}
          className="absolute z-50 mt-1 w-full max-h-72 overflow-y-auto rounded-lg border border-border bg-bg-surface shadow-lg"
        >
          {isError && (
            <li className="px-4 py-3 text-sm text-red-400">
              Erro ao buscar. Tente novamente.
            </li>
          )}

          {!isError && !isFetching && items.length === 0 && (
            <li className="px-4 py-3 text-sm text-text-muted">
              Nenhum produto encontrado.
            </li>
          )}

          {items.map((item, i) => (
            <li key={item.variation_id}>
              <button
                type="button"
                onMouseDown={() => handleSelect(item)}
                className={`w-full text-left px-4 py-2.5 flex items-center justify-between gap-3 transition-colors
                  ${i === cursor ? 'bg-brand/10 text-brand' : 'hover:bg-bg-overlay text-text-primary'}`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{item.product_name}</p>
                  <p className="text-xs text-text-muted mt-0.5 flex flex-wrap gap-x-2">
                    {item.tamanho && <span>Tam: <span className="font-medium">{item.tamanho}</span></span>}
                    {item.cor     && <span>Cor: <span className="font-medium">{item.cor}</span></span>}
                    <span className="font-mono">{item.sku}</span>
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-semibold">{formatCurrency(item.price)}</p>
                  <p className="text-xs text-text-muted">{item.stock} em estoque</p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
