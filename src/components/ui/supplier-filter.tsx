'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { SUPPLIER_QUERY_PARAM, type SupplierOption } from '@/lib/suppliers/filter'

/**
 * Filtro "Fornecedor" das listagens (/produtos e /estoque). Mesmo padrão dos demais
 * filtros: só mexe em query params — preserva `q`/`atacado`/`situacao`/etc. e zera
 * `page` ao trocar (quem não tem paginação simplesmente ignora).
 */
export function SupplierFilter({ suppliers, selected }: { suppliers: SupplierOption[]; selected?: number }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  function change(value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (value) params.set(SUPPLIER_QUERY_PARAM, value)
    else params.delete(SUPPLIER_QUERY_PARAM)
    params.delete('page')
    router.replace(`${pathname}?${params.toString()}`)
  }

  return (
    <label className="flex items-center gap-2 text-sm text-text-muted">
      Fornecedor
      <select
        className="input-base py-1.5 text-sm"
        value={selected !== undefined ? String(selected) : ''}
        onChange={(e) => change(e.target.value)}
      >
        <option value="">Todos os fornecedores</option>
        {/* ID vindo da URL que não está na lista (outra empresa/inativo): mantém o valor visível, o resultado é vazio. */}
        {selected !== undefined && !suppliers.some((s) => s.id === selected) && <option value={String(selected)}>Fornecedor #{selected}</option>}
        {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  )
}
