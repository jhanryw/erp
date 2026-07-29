'use client'

import { useCallback, useRef, useTransition } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const

const CATEGORY_OPTIONS = [
  { value: 'sale', label: 'Venda' },
  { value: 'cashback_used', label: 'Cashback Utilizado' },
  { value: 'other_income', label: 'Outra Receita' },
  { value: 'stock_purchase', label: 'Compra de Estoque' },
  { value: 'freight_cost', label: 'Frete' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'rent', label: 'Aluguel' },
  { value: 'salaries', label: 'Salários' },
  { value: 'operational', label: 'Operacional' },
  { value: 'taxes', label: 'Impostos' },
  { value: 'other_expense', label: 'Outra Despesa' },
]

const ORIGIN_OPTIONS = [
  { value: 'manual', label: 'Manual' },
  { value: 'sale', label: 'Venda' },
  { value: 'stock', label: 'Estoque' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'return', label: 'Devolução' },
  { value: 'cash', label: 'Caixa' },
]

interface LancamentosFiltersProps {
  defaultQ?: string
}

export function LancamentosFilters({ defaultQ }: LancamentosFiltersProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [, startTransition] = useTransition()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const updateParams = useCallback(
    (updates: Record<string, string | undefined>, resetPage = true) => {
      const params = new URLSearchParams(searchParams.toString())
      for (const [key, value] of Object.entries(updates)) {
        if (value) params.set(key, value)
        else params.delete(key)
      }
      if (resetPage) params.delete('page')
      startTransition(() => {
        router.replace(`${pathname}?${params.toString()}`)
      })
    },
    [router, pathname, searchParams],
  )

  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value.trim()
    if (debounceRef.current) clearTimeout(debounceRef.current)
    // Busca combina normalmente com os filtros de data ativos — nunca os
    // desliga sozinha. Para pesquisar em todo o histórico, o usuário clica
    // em "Ver todo o histórico" (que seta allTime=1) antes ou depois de buscar.
    debounceRef.current = setTimeout(() => updateParams({ q: value || undefined }), 300)
  }

  function handleReferenceMonthChange(e: React.ChangeEvent<HTMLInputElement>) {
    const month = e.target.value
    if (!month) {
      updateParams({ referenceFrom: undefined, referenceTo: undefined })
      return
    }
    const [year, monthNum] = month.split('-').map(Number)
    const lastDay = new Date(year, monthNum, 0).getDate()
    updateParams({
      referenceFrom: `${month}-01`,
      referenceTo: `${month}-${String(lastDay).padStart(2, '0')}`,
    })
  }

  const createdFrom = searchParams.get('createdFrom') ?? ''
  const createdTo = searchParams.get('createdTo') ?? ''
  const referenceFrom = searchParams.get('referenceFrom') ?? ''
  const referenceTo = searchParams.get('referenceTo') ?? ''

  // "Mês de competência" só é preenchido quando referenceFrom/referenceTo
  // formam um mês fechado (início e fim do mesmo mês) — do contrário deixa
  // em branco, já que o usuário pode ter definido um range livre.
  const monthMatch = /^(\d{4}-\d{2})-01$/.exec(referenceFrom)
  const monthValue =
    monthMatch && referenceTo === `${monthMatch[1]}-${String(new Date(Number(monthMatch[1].slice(0, 4)), Number(monthMatch[1].slice(5, 7)), 0).getDate()).padStart(2, '0')}`
      ? monthMatch[1]
      : ''

  return (
    <div className="card p-4 space-y-4">
      <div className="relative w-full">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted pointer-events-none" />
        <Input
          type="search"
          placeholder="Buscar por descrição ou observações (ex: aluguel)..."
          defaultValue={defaultQ}
          onChange={handleSearchChange}
          className="pl-9"
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Select
          label="Tipo"
          defaultValue={searchParams.get('type') ?? ''}
          onChange={(e) => updateParams({ type: e.target.value || undefined })}
        >
          <option value="">Todos</option>
          <option value="income">Receita</option>
          <option value="expense">Despesa</option>
        </Select>

        <Select
          label="Categoria"
          defaultValue={searchParams.get('category') ?? ''}
          onChange={(e) => updateParams({ category: e.target.value || undefined })}
        >
          <option value="">Todas</option>
          {CATEGORY_OPTIONS.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </Select>

        <Select
          label="Status"
          defaultValue={searchParams.get('status') ?? ''}
          onChange={(e) => updateParams({ status: e.target.value || undefined })}
        >
          <option value="">Todos</option>
          <option value="paid">Pago/Recebido</option>
          <option value="pending">Pendente</option>
        </Select>

        <Select
          label="Origem"
          defaultValue={searchParams.get('origin') ?? ''}
          onChange={(e) => updateParams({ origin: e.target.value || undefined })}
        >
          <option value="">Todas</option>
          {ORIGIN_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>
      </div>

      {/* Grupo 1 — data de criação no sistema (created_at). Usado para
          auditar importações/regularizações recentes, ex.: a leva do Caixa
          criada em 11/07/2026 com reference_date de meses anteriores. */}
      <div>
        <p className="text-xs font-medium text-text-secondary mb-1.5">Data de criação no sistema</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Input
            label="Criado a partir de"
            type="date"
            defaultValue={createdFrom}
            onChange={(e) => updateParams({ createdFrom: e.target.value || undefined, allTime: undefined })}
          />
          <Input
            label="Criado até"
            type="date"
            defaultValue={createdTo}
            onChange={(e) => updateParams({ createdTo: e.target.value || undefined, allTime: undefined })}
          />
        </div>
      </div>

      {/* Grupo 2 — competência financeira (reference_date). Sem valor
          padrão — usado para análise contábil, independente de quando o
          lançamento foi cadastrado no sistema. */}
      <div>
        <p className="text-xs font-medium text-text-secondary mb-1.5">Competência financeira</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Input
            label="Competência inicial"
            type="date"
            defaultValue={referenceFrom}
            onChange={(e) => updateParams({ referenceFrom: e.target.value || undefined })}
          />
          <Input
            label="Competência final"
            type="date"
            defaultValue={referenceTo}
            onChange={(e) => updateParams({ referenceTo: e.target.value || undefined })}
          />
          <div className="w-40">
            <Input
              label="Mês de competência"
              type="month"
              defaultValue={monthValue}
              onChange={handleReferenceMonthChange}
            />
          </div>
        </div>
      </div>

      <div className="flex items-end justify-end gap-3 flex-wrap">
        <div className="w-56">
          <Select
            label="Ordenar por"
            defaultValue={searchParams.get('sort') ?? 'created_at'}
            onChange={(e) => updateParams({ sort: e.target.value === 'created_at' ? undefined : e.target.value })}
          >
            <option value="created_at">Cadastro no sistema (mais recentes)</option>
            <option value="reference_date">Competência (mais recentes)</option>
          </Select>
        </div>

        <div className="w-32">
          <Select
            label="Por página"
            defaultValue={searchParams.get('pageSize') ?? '50'}
            onChange={(e) => updateParams({ pageSize: e.target.value })}
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </Select>
        </div>
      </div>
    </div>
  )
}
