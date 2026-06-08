import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface PaginationProps {
  page: number
  totalPages: number
  baseUrl: string   // ex.: "/clientes" ou "/vendas"
  query?: string    // mantém o ?q= ao navegar entre páginas
}

export function Pagination({ page, totalPages, baseUrl, query }: PaginationProps) {
  if (totalPages <= 1) return null

  function href(p: number) {
    const params = new URLSearchParams()
    if (query) params.set('q', query)
    params.set('page', String(p))
    return `${baseUrl}?${params.toString()}`
  }

  // Janela de páginas: mostra no máximo 5 ao redor da atual
  const window = 2
  const start = Math.max(1, page - window)
  const end   = Math.min(totalPages, page + window)
  const pages = Array.from({ length: end - start + 1 }, (_, i) => start + i)

  return (
    <div className="flex items-center justify-center gap-1 pt-2 pb-4">

      {/* Anterior */}
      {page > 1 ? (
        <Link
          href={href(page - 1)}
          className="flex items-center justify-center w-8 h-8 rounded-lg text-sm text-text-secondary hover:bg-bg-hover transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
        </Link>
      ) : (
        <span className="w-8 h-8" />
      )}

      {/* Primeira página se não visível */}
      {start > 1 && (
        <>
          <Link href={href(1)} className={pageClass(1, page)}>1</Link>
          {start > 2 && <span className="w-8 h-8 flex items-center justify-center text-text-muted text-sm">…</span>}
        </>
      )}

      {/* Páginas da janela */}
      {pages.map((p) => (
        <Link key={p} href={href(p)} className={pageClass(p, page)}>
          {p}
        </Link>
      ))}

      {/* Última página se não visível */}
      {end < totalPages && (
        <>
          {end < totalPages - 1 && <span className="w-8 h-8 flex items-center justify-center text-text-muted text-sm">…</span>}
          <Link href={href(totalPages)} className={pageClass(totalPages, page)}>{totalPages}</Link>
        </>
      )}

      {/* Próxima */}
      {page < totalPages ? (
        <Link
          href={href(page + 1)}
          className="flex items-center justify-center w-8 h-8 rounded-lg text-sm text-text-secondary hover:bg-bg-hover transition-colors"
        >
          <ChevronRight className="w-4 h-4" />
        </Link>
      ) : (
        <span className="w-8 h-8" />
      )}
    </div>
  )
}

function pageClass(p: number, current: number) {
  return `flex items-center justify-center w-8 h-8 rounded-lg text-sm font-medium transition-colors ${
    p === current
      ? 'bg-brand text-white'
      : 'text-text-secondary hover:bg-bg-hover'
  }`
}
