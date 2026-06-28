'use client'

import { useState, useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'
import { filterProducts } from '@/lib/utils/product-search'

export type ProductOption = { id: number; name: string; sku: string }

interface Props {
  products: ProductOption[]
  value: ProductOption | null
  onChange: (product: ProductOption | null) => void
  placeholder?: string
  disabled?: boolean
}

export function ProductSearchCombobox({
  products,
  value,
  onChange,
  placeholder = 'Digite o nome ou SKU do produto...',
  disabled = false,
}: Props) {
  const [query, setQuery]     = useState(value?.name ?? '')
  const [open, setOpen]       = useState(false)
  const [suggestions, setSuggestions] = useState<ProductOption[]>([])
  const containerRef = useRef<HTMLDivElement>(null)

  // Sync display text when external value changes
  useEffect(() => {
    setQuery(value?.name ?? '')
  }, [value])

  // Recompute suggestions on every keystroke
  useEffect(() => {
    setSuggestions(filterProducts(products, value ? '' : query))
  }, [query, products, value])

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        // If user typed something but didn't pick → restore selected name or clear
        if (!value) setQuery('')
        else setQuery(value.name)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [value])

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value
    setQuery(v)
    onChange(null) // clear selection when typing again
    setOpen(true)
  }

  function handleSelect(p: ProductOption) {
    onChange(p)
    setQuery(p.name)
    setOpen(false)
  }

  function handleClear() {
    onChange(null)
    setQuery('')
    setOpen(false)
  }

  const showList = open && suggestions.length > 0 && !value
  const noResults = open && query.trim().length > 0 && suggestions.length === 0 && !value

  return (
    <div ref={containerRef} className="relative w-full">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
      <input
        type="text"
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={handleInput}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        className="w-full bg-bg-input border border-border text-text-primary text-sm rounded-lg pl-9 pr-9 py-2 focus:outline-none focus:border-brand disabled:opacity-50 disabled:cursor-not-allowed"
      />

      {/* Clear button – only show when something is typed or selected */}
      {query && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
          tabIndex={-1}
        >
          <X className="w-4 h-4" />
        </button>
      )}

      {/* Suggestions dropdown */}
      {showList && (
        <ul className="absolute z-30 mt-1 w-full rounded-lg border border-border bg-bg-card shadow-lg max-h-64 overflow-y-auto">
          {suggestions.map((p) => (
            <li
              key={p.id}
              className="flex items-baseline gap-2 px-3 py-2 cursor-pointer hover:bg-bg-hover transition-colors text-sm select-none"
              onMouseDown={(e) => { e.preventDefault(); handleSelect(p) }}
            >
              <span className="font-medium text-text-primary flex-1 truncate">{p.name}</span>
              <span className="text-xs text-text-muted font-mono shrink-0">{p.sku}</span>
            </li>
          ))}
        </ul>
      )}

      {noResults && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-border bg-bg-card shadow-lg px-3 py-3 text-sm text-text-muted">
          Nenhum produto encontrado para &quot;{query}&quot;
        </div>
      )}
    </div>
  )
}
