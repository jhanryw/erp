'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'

// Filtros do atacado na lista de produtos — só mexem em query params (mantêm
// `q`, zeram `page`). A situação (vendável/sem preço/...) só se aplica a
// produtos habilitados no atacado.
export function WholesaleFilters({ atacado, situacao }: { atacado?: string; situacao?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  function set(key: 'atacado' | 'situacao', value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (value) params.set(key, value)
    else params.delete(key)
    params.delete('page')
    router.replace(`${pathname}?${params.toString()}`)
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2 text-sm text-text-muted">
        Atacado
        <select className="input-base py-1.5 text-sm" value={atacado ?? ''} onChange={(e) => set('atacado', e.target.value)}>
          <option value="">Todos</option>
          <option value="ativos">Ativos</option>
          <option value="inativos">Inativos</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm text-text-muted">
        Situação no atacado
        <select className="input-base py-1.5 text-sm" value={situacao ?? ''} onChange={(e) => set('situacao', e.target.value)}>
          <option value="">Todas</option>
          <option value="vendaveis">Vendáveis</option>
          <option value="sem_preco">Sem preço</option>
          <option value="sem_estoque">Sem estoque</option>
          <option value="sem_imagem">Sem imagem</option>
        </select>
      </label>
    </div>
  )
}
