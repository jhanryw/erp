'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'
import { ExternalLink } from 'lucide-react'

export type PurchaseSuggestion = {
  product_id: number
  product_name: string
  sku: string
  product_variation_id: number
  sku_variation: string
  color: string | null
  size: string | null
  current_qty: number
  qty_sold_30d: number
  qty_sold_90d: number
  daily_velocity: string
  coverage_days: number | null
  estimated_lead_time_days: number
  min_stock_suggested: number
  suggested_purchase_qty: number
  recommended_supplier_id: number | null
  recommended_supplier_name: string | null
  recommended_avg_cost_per_unit: string | null
  estimated_restock_cost: string
  urgency: 'critica' | 'alta' | 'media' | 'baixa'
  is_rupture: boolean
  is_dead_stock: boolean
  is_overstock: boolean
  target_stock_days: number
  margin_pct: number
  selling_price: number
  unit_cost_estimate: string
  last_purchase_date?: string | null
}

const URGENCY_ORDER: Record<string, number> = { critica: 0, alta: 1, media: 2, baixa: 3 }

const URGENCY_LABELS: Record<string, string> = {
  critica: 'Crítica',
  alta:    'Alta',
  media:   'Média',
  baixa:   'Baixa',
}

const URGENCY_VARIANTS: Record<string, 'error' | 'warning' | 'info' | 'default'> = {
  critica: 'error',
  alta:    'warning',
  media:   'info',
  baixa:   'default',
}

type FilterButtonProps = {
  active: boolean
  onClick: () => void
  color?: 'critica' | 'alta' | 'media' | 'brand'
  children: React.ReactNode
}

function FilterButton({ active, onClick, color = 'brand', children }: FilterButtonProps) {
  const activeClass =
    color === 'critica' ? 'bg-error/15 border-error/50 text-error' :
    color === 'alta'    ? 'bg-warning/15 border-warning/50 text-warning' :
    color === 'media'   ? 'bg-info/15 border-info/50 text-info' :
                          'bg-brand/15 border-brand/50 text-brand'
  return (
    <button
      onClick={onClick}
      className={`text-xs px-2.5 py-1 rounded-full border transition-colors font-medium ${
        active ? activeClass : 'bg-transparent border-border text-text-muted hover:border-text-muted'
      }`}
    >
      {children}
    </button>
  )
}

type SituacaoKey = 'ruptura' | 'parado' | 'overstock'

const SITUACAO_LABELS: Record<SituacaoKey, string> = {
  ruptura:  'Ruptura',
  parado:   'Parado',
  overstock: 'Excesso',
}

export function ComprasTable({ suggestions }: { suggestions: PurchaseSuggestion[] }) {
  const [filterUrgency,  setFilterUrgency]  = useState('all')
  const [filterSituacao, setFilterSituacao] = useState<SituacaoKey | 'all'>('all')
  const [filterSupplier, setFilterSupplier] = useState('all')
  const [search,         setSearch]         = useState('')

  const supplierOptions = useMemo(() => {
    const names = suggestions
      .map(s => s.recommended_supplier_name)
      .filter((n): n is string => n !== null && n !== '')
    return [...new Set(names)].sort()
  }, [suggestions])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return suggestions
      .filter(s => filterUrgency === 'all' || s.urgency === filterUrgency)
      .filter(s => {
        if (filterSituacao === 'all')      return true
        if (filterSituacao === 'ruptura')  return s.is_rupture
        if (filterSituacao === 'parado')   return s.is_dead_stock
        if (filterSituacao === 'overstock') return s.is_overstock
        return true
      })
      .filter(s => filterSupplier === 'all' || s.recommended_supplier_name === filterSupplier)
      .filter(s => !q ||
        s.product_name.toLowerCase().includes(q) ||
        s.sku_variation.toLowerCase().includes(q) ||
        s.sku.toLowerCase().includes(q)
      )
      .sort((a, b) => {
        const u = (URGENCY_ORDER[a.urgency] ?? 9) - (URGENCY_ORDER[b.urgency] ?? 9)
        if (u !== 0) return u
        if (a.coverage_days === null) return 1
        if (b.coverage_days === null) return -1
        return a.coverage_days - b.coverage_days
      })
  }, [suggestions, filterUrgency, filterSituacao, filterSupplier, search])

  const hasFilters = filterUrgency !== 'all' || filterSituacao !== 'all' ||
    filterSupplier !== 'all' || search !== ''

  function clearFilters() {
    setFilterUrgency('all')
    setFilterSituacao('all')
    setFilterSupplier('all')
    setSearch('')
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">Sugestões de Reposição</h3>
          {hasFilters && (
            <button onClick={clearFilters} className="text-xs text-accent hover:underline">
              Limpar filtros ({filtered.length} de {suggestions.length})
            </button>
          )}
        </div>

        <div className="flex flex-col gap-3 mt-3">
          {/* Busca */}
          <input
            type="text"
            placeholder="Buscar por produto ou SKU…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="input-base text-sm w-full sm:w-72"
          />

          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {/* Urgência */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-text-muted">Urgência:</span>
              <FilterButton active={filterUrgency === 'all'}     onClick={() => setFilterUrgency('all')}>Todas</FilterButton>
              <FilterButton active={filterUrgency === 'critica'} onClick={() => setFilterUrgency('critica')} color="critica">Crítica</FilterButton>
              <FilterButton active={filterUrgency === 'alta'}    onClick={() => setFilterUrgency('alta')}    color="alta">Alta</FilterButton>
              <FilterButton active={filterUrgency === 'media'}   onClick={() => setFilterUrgency('media')}   color="media">Média</FilterButton>
              <FilterButton active={filterUrgency === 'baixa'}   onClick={() => setFilterUrgency('baixa')}>Baixa</FilterButton>
            </div>

            {/* Situação */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-text-muted">Situação:</span>
              <FilterButton active={filterSituacao === 'all'}      onClick={() => setFilterSituacao('all')}>Todas</FilterButton>
              {(['ruptura', 'parado', 'overstock'] as SituacaoKey[]).map(k => (
                <FilterButton key={k} active={filterSituacao === k} onClick={() => setFilterSituacao(k)}>
                  {SITUACAO_LABELS[k]}
                </FilterButton>
              ))}
            </div>

            {/* Fornecedor */}
            {supplierOptions.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-text-muted">Fornecedor:</span>
                <select
                  value={filterSupplier}
                  onChange={e => setFilterSupplier(e.target.value)}
                  className="text-xs px-2.5 py-1 rounded-md border border-border bg-bg-surface text-text-secondary focus:border-brand focus:outline-none cursor-pointer"
                >
                  <option value="all">Todos</option>
                  {supplierOptions.map(name => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>
      </CardHeader>

      {suggestions.length === 0 ? (
        <div className="p-16 text-center space-y-2">
          <p className="text-3xl">📦</p>
          <p className="text-sm font-semibold text-text-primary">Nenhuma sugestão de compra no momento.</p>
          <p className="text-xs text-text-muted">Estoque e vendas em equilíbrio.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-10 text-center text-sm text-text-muted">
          Nenhuma sugestão para os filtros selecionados.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Urgência</TableHead>
                <TableHead>Produto / Variação</TableHead>
                <TableHead align="right">Estoque</TableHead>
                <TableHead align="right">Vendas 30d</TableHead>
                <TableHead align="right">Vendas 90d</TableHead>
                <TableHead align="right">Cobertura</TableHead>
                <TableHead align="right">Qtd sugerida</TableHead>
                <TableHead align="right">Custo estimado</TableHead>
                <TableHead>Fornecedor recomendado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(s => (
                <TableRow key={`${s.product_variation_id}`}>
                  {/* Urgência */}
                  <TableCell>
                    <Badge variant={URGENCY_VARIANTS[s.urgency] ?? 'default'} size="sm">
                      {URGENCY_LABELS[s.urgency] ?? s.urgency}
                    </Badge>
                  </TableCell>

                  {/* Produto / Variação */}
                  <TableCell>
                    <div className="flex items-start gap-1.5">
                      <div>
                        <span className="text-sm font-medium text-text-primary block leading-tight">
                          {s.product_name}
                        </span>
                        <span className="text-xs text-text-muted">
                          {s.sku_variation}
                          {s.color && ` · ${s.color}`}
                          {s.size  && ` · ${s.size}`}
                        </span>
                      </div>
                      <Link
                        href={`/produtos/${s.product_id}`}
                        className="shrink-0 mt-0.5 text-text-muted hover:text-brand transition-colors"
                        title="Ver produto"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </Link>
                    </div>
                  </TableCell>

                  {/* Estoque atual */}
                  <TableCell align="right">
                    <span className={`text-sm font-medium ${s.current_qty === 0 ? 'text-error' : 'text-text-primary'}`}>
                      {s.current_qty}
                    </span>
                  </TableCell>

                  {/* Vendas 30d */}
                  <TableCell align="right" muted>
                    {s.qty_sold_30d}
                  </TableCell>

                  {/* Vendas 90d */}
                  <TableCell align="right" muted>
                    {s.qty_sold_90d}
                  </TableCell>

                  {/* Cobertura em dias */}
                  <TableCell align="right">
                    {s.coverage_days === null ? (
                      <span className="text-xs text-text-muted">—</span>
                    ) : s.coverage_days === 0 ? (
                      <span className="text-sm font-medium text-error">0d</span>
                    ) : (
                      <span className={`text-sm font-medium ${
                        s.coverage_days < s.estimated_lead_time_days     ? 'text-error' :
                        s.coverage_days < s.estimated_lead_time_days * 2 ? 'text-warning' :
                        'text-text-primary'
                      }`}>
                        {s.coverage_days}d
                      </span>
                    )}
                  </TableCell>

                  {/* Qtd sugerida */}
                  <TableCell align="right">
                    <span className={`text-sm font-semibold ${s.suggested_purchase_qty > 0 ? 'text-brand' : 'text-text-muted'}`}>
                      {s.suggested_purchase_qty > 0 ? s.suggested_purchase_qty : '—'}
                    </span>
                  </TableCell>

                  {/* Custo estimado */}
                  <TableCell align="right">
                    <span className="text-sm text-text-primary">
                      {parseFloat(s.estimated_restock_cost) > 0
                        ? formatCurrency(parseFloat(s.estimated_restock_cost))
                        : <span className="text-text-muted">—</span>
                      }
                    </span>
                  </TableCell>

                  {/* Fornecedor recomendado */}
                  <TableCell>
                    {s.recommended_supplier_name ? (
                      <div className="flex items-start gap-1.5">
                        <div>
                          <span className="text-sm text-text-primary block leading-tight">
                            {s.recommended_supplier_name}
                          </span>
                          {s.recommended_avg_cost_per_unit && (
                            <span className="text-xs text-text-muted">
                              {formatCurrency(parseFloat(s.recommended_avg_cost_per_unit))}/un
                            </span>
                          )}
                        </div>
                        {s.recommended_supplier_id && (
                          <Link
                            href={`/fornecedores/${s.recommended_supplier_id}`}
                            className="shrink-0 mt-0.5 text-text-muted hover:text-brand transition-colors"
                            title="Ver fornecedor"
                          >
                            <ExternalLink className="w-3 h-3" />
                          </Link>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-text-muted italic">
                        Sem fornecedor recente (180d)
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  )
}
