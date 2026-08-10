'use client'

import { useState, useMemo, Fragment } from 'react'
import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'
import { ExternalLink, ChevronDown, ChevronRight } from 'lucide-react'
import {
  CURVE_LABELS,
  URGENCY_LABELS,
  type PolicyCurve,
  type PolicyUrgency,
} from '@/lib/constants/purchasePolicy'
import {
  sortBySuggestedPriority,
  type EnrichedPurchaseSuggestion,
} from '@/services/purchaseSuggestions'

const URGENCY_VARIANTS: Record<PolicyUrgency, 'error' | 'warning' | 'info' | 'default' | 'success' | 'brand'> = {
  critica: 'error',
  alta: 'warning',
  media: 'info',
  baixa: 'default',
  ok: 'success',
  reposicao_minima: 'brand',
  nao_repor: 'default',
}

const CURVE_VARIANTS: Record<PolicyCurve, 'error' | 'warning' | 'info' | 'default' | 'brand'> = {
  A: 'error',
  B: 'warning',
  C: 'default',
  NEW: 'info',
  NO_ABC: 'default',
}

type FilterButtonProps = {
  active: boolean
  onClick: () => void
  variant?: 'error' | 'warning' | 'info' | 'brand' | 'default'
  children: React.ReactNode
}

function FilterButton({ active, onClick, variant = 'default', children }: FilterButtonProps) {
  const activeClass =
    variant === 'error'   ? 'bg-error/15 border-error/50 text-error' :
    variant === 'warning' ? 'bg-warning/15 border-warning/50 text-warning' :
    variant === 'info'    ? 'bg-info/15 border-info/50 text-info' :
    variant === 'brand'   ? 'bg-brand/15 border-brand/50 text-brand' :
                             'bg-bg-overlay border-border text-text-secondary'
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

function formatDays(days: number | null): string {
  if (days === null) return '—'
  return `${Math.round(days)}d`
}

function coverageColor(days: number | null, targetDays: number | null): string {
  if (days === null) return 'text-text-muted'
  if (targetDays === null) return 'text-text-primary' // Curva C não tem target de dias
  if (days <= targetDays * 0.25) return 'text-error'
  if (days <= targetDays * 0.6) return 'text-warning'
  return 'text-text-primary'
}

export function ComprasTable({ suggestions }: { suggestions: EnrichedPurchaseSuggestion[] }) {
  const [filterCurve, setFilterCurve] = useState<PolicyCurve | 'all'>('all')
  const [filterUrgency, setFilterUrgency] = useState<PolicyUrgency | 'all'>('all')
  const [filterSupplier, setFilterSupplier] = useState('all')
  const [filterCategory, setFilterCategory] = useState('all')
  const [onlyBuyNow, setOnlyBuyNow] = useState(false)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  function toggleExpanded(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const supplierOptions = useMemo(() => {
    const names = suggestions
      .map((s) => s.recommendedSupplierName)
      .filter((n): n is string => !!n)
    return [...new Set(names)].sort()
  }, [suggestions])

  const categoryOptions = useMemo(() => {
    const names = suggestions
      .map((s) => s.categoryName)
      .filter((n): n is string => !!n)
    return [...new Set(names)].sort()
  }, [suggestions])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = suggestions
      .filter((s) => filterCurve === 'all' || s.policyCurve === filterCurve)
      .filter((s) => filterUrgency === 'all' || s.urgency === filterUrgency)
      .filter((s) => filterSupplier === 'all' || s.recommendedSupplierName === filterSupplier)
      .filter((s) => filterCategory === 'all' || s.categoryName === filterCategory)
      .filter((s) => !onlyBuyNow || s.suggestedQty > 0)
      .filter(
        (s) =>
          !q ||
          s.productName.toLowerCase().includes(q) ||
          s.skuVariation.toLowerCase().includes(q) ||
          s.sku.toLowerCase().includes(q),
      )
    return sortBySuggestedPriority(rows)
  }, [suggestions, filterCurve, filterUrgency, filterSupplier, filterCategory, onlyBuyNow, search])

  const hasFilters =
    filterCurve !== 'all' ||
    filterUrgency !== 'all' ||
    filterSupplier !== 'all' ||
    filterCategory !== 'all' ||
    onlyBuyNow ||
    search !== ''

  function clearFilters() {
    setFilterCurve('all')
    setFilterUrgency('all')
    setFilterSupplier('all')
    setFilterCategory('all')
    setOnlyBuyNow(false)
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
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              placeholder="Buscar por produto ou SKU…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input-base text-sm w-full sm:w-72"
            />
            <FilterButton active={onlyBuyNow} onClick={() => setOnlyBuyNow((v) => !v)} variant="brand">
              Só comprar agora
            </FilterButton>
          </div>

          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {/* Curva */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-text-muted">Curva:</span>
              <FilterButton active={filterCurve === 'all'} onClick={() => setFilterCurve('all')}>Todas</FilterButton>
              <FilterButton active={filterCurve === 'A'} onClick={() => setFilterCurve('A')} variant="error">A</FilterButton>
              <FilterButton active={filterCurve === 'B'} onClick={() => setFilterCurve('B')} variant="warning">B</FilterButton>
              <FilterButton active={filterCurve === 'C'} onClick={() => setFilterCurve('C')}>C</FilterButton>
              <FilterButton active={filterCurve === 'NEW'} onClick={() => setFilterCurve('NEW')} variant="info">Novo</FilterButton>
              <FilterButton active={filterCurve === 'NO_ABC'} onClick={() => setFilterCurve('NO_ABC')}>Sem ABC</FilterButton>
            </div>

            {/* Urgência */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-text-muted">Urgência:</span>
              <FilterButton active={filterUrgency === 'all'} onClick={() => setFilterUrgency('all')}>Todas</FilterButton>
              {(['critica', 'alta', 'media', 'baixa'] as PolicyUrgency[]).map((u) => (
                <FilterButton
                  key={u}
                  active={filterUrgency === u}
                  onClick={() => setFilterUrgency(u)}
                  variant={URGENCY_VARIANTS[u] as 'error' | 'warning' | 'info' | 'default'}
                >
                  {URGENCY_LABELS[u]}
                </FilterButton>
              ))}
            </div>

            {/* Fornecedor */}
            {supplierOptions.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-text-muted">Fornecedor:</span>
                <select
                  value={filterSupplier}
                  onChange={(e) => setFilterSupplier(e.target.value)}
                  className="text-xs px-2.5 py-1 rounded-md border border-border bg-bg-surface text-text-secondary focus:border-brand focus:outline-none cursor-pointer"
                >
                  <option value="all">Todos</option>
                  {supplierOptions.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Categoria */}
            {categoryOptions.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-text-muted">Categoria:</span>
                <select
                  value={filterCategory}
                  onChange={(e) => setFilterCategory(e.target.value)}
                  className="text-xs px-2.5 py-1 rounded-md border border-border bg-bg-surface text-text-secondary focus:border-brand focus:outline-none cursor-pointer"
                >
                  <option value="all">Todas</option>
                  {categoryOptions.map((name) => (
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
                <TableHead />
                <TableHead>Prioridade</TableHead>
                <TableHead>Curva</TableHead>
                <TableHead>Produto / Variação</TableHead>
                <TableHead align="right">Estoque</TableHead>
                <TableHead align="right">Cobertura</TableHead>
                <TableHead align="right">Cobertura-alvo</TableHead>
                <TableHead align="right">Qtd sugerida</TableHead>
                <TableHead align="right">Custo estimado</TableHead>
                <TableHead>Fornecedor recomendado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((s) => {
                const isExpanded = expanded.has(s.productVariationId)
                return (
                  <Fragment key={s.productVariationId}>
                    <TableRow>
                      <TableCell>
                        <button
                          onClick={() => toggleExpanded(s.productVariationId)}
                          className="text-text-muted hover:text-brand transition-colors"
                          title="Ver detalhes"
                        >
                          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        </button>
                      </TableCell>

                      {/* Prioridade / Urgência */}
                      <TableCell>
                        <Badge variant={URGENCY_VARIANTS[s.urgency]} size="sm">
                          {URGENCY_LABELS[s.urgency]}
                        </Badge>
                      </TableCell>

                      {/* Curva */}
                      <TableCell>
                        <Badge variant={CURVE_VARIANTS[s.policyCurve]} size="sm">
                          {CURVE_LABELS[s.policyCurve]}
                        </Badge>
                      </TableCell>

                      {/* Produto / Variação */}
                      <TableCell>
                        <div className="flex items-start gap-1.5">
                          <div>
                            <span className="text-sm font-medium text-text-primary block leading-tight">
                              {s.productName}
                            </span>
                            <span className="text-xs text-text-muted">
                              {s.skuVariation}
                              {s.color && ` · ${s.color}`}
                              {s.size && ` · ${s.size}`}
                            </span>
                          </div>
                          <Link
                            href={`/produtos/${s.productId}`}
                            className="shrink-0 mt-0.5 text-text-muted hover:text-brand transition-colors"
                            title="Ver produto"
                          >
                            <ExternalLink className="w-3 h-3" />
                          </Link>
                        </div>
                      </TableCell>

                      {/* Estoque atual */}
                      <TableCell align="right">
                        <span className={`text-sm font-medium ${s.availableStock === 0 ? 'text-error' : 'text-text-primary'}`}>
                          {s.availableStock}
                        </span>
                      </TableCell>

                      {/* Cobertura atual */}
                      <TableCell align="right">
                        <span className={`text-sm font-medium ${coverageColor(s.coverageDays, s.targetDays)}`}>
                          {formatDays(s.coverageDays)}
                        </span>
                      </TableCell>

                      {/* Cobertura-alvo */}
                      <TableCell align="right" muted>
                        {s.policyCurve === 'C' ? 'Mínimo' : `${s.targetDays}d`}
                      </TableCell>

                      {/* Qtd sugerida */}
                      <TableCell align="right">
                        <span className={`text-sm font-semibold ${s.suggestedQty > 0 ? 'text-brand' : 'text-text-muted'}`}>
                          {s.suggestedQty > 0 ? s.suggestedQty : '—'}
                        </span>
                      </TableCell>

                      {/* Custo estimado */}
                      <TableCell align="right">
                        <span className={`text-sm ${s.estimatedCost > 0 ? 'font-semibold text-text-primary' : 'text-text-muted'}`}>
                          {s.estimatedCost > 0 ? formatCurrency(s.estimatedCost) : '—'}
                        </span>
                      </TableCell>

                      {/* Fornecedor recomendado */}
                      <TableCell>
                        {s.recommendedSupplierName ? (
                          <div className="flex items-start gap-1.5">
                            <div>
                              <span className="text-sm text-text-primary block leading-tight">
                                {s.recommendedSupplierName}
                              </span>
                              {s.recommendedAvgCostPerUnit !== null && (
                                <span className="text-xs text-text-muted">
                                  {formatCurrency(s.recommendedAvgCostPerUnit)}/un
                                </span>
                              )}
                            </div>
                            {s.recommendedSupplierId && (
                              <Link
                                href={`/fornecedores/${s.recommendedSupplierId}`}
                                className="shrink-0 mt-0.5 text-text-muted hover:text-brand transition-colors"
                                title="Ver fornecedor"
                              >
                                <ExternalLink className="w-3 h-3" />
                              </Link>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-text-muted italic">Sem fornecedor recente (180d)</span>
                        )}
                      </TableCell>
                    </TableRow>

                    {isExpanded && (
                      <TableRow>
                        <TableCell colSpan={10}>
                          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-x-6 gap-y-2 py-1 text-xs">
                            <div>
                              <p className="text-text-muted">Vendas 30d</p>
                              <p className="text-text-primary font-medium">{s.qtySold30d}</p>
                            </div>
                            <div>
                              <p className="text-text-muted">Vendas 90d</p>
                              <p className="text-text-primary font-medium">{s.qtySold90d}</p>
                            </div>
                            <div>
                              <p className="text-text-muted">VMD 30d</p>
                              <p className="text-text-primary font-medium">{s.vmd30.toFixed(3)}</p>
                            </div>
                            <div>
                              <p className="text-text-muted">VMD 90d</p>
                              <p className="text-text-primary font-medium">{s.vmd90.toFixed(3)}</p>
                            </div>
                            <div>
                              <p className="text-text-muted">VMD projetada</p>
                              <p className="text-text-primary font-medium">{s.vmdProjetada.toFixed(3)}</p>
                            </div>
                            <div>
                              <p className="text-text-muted">Estoque-alvo</p>
                              <p className="text-text-primary font-medium">{s.targetStock ?? '—'}</p>
                            </div>
                            <div>
                              <p className="text-text-muted">Custo unitário</p>
                              <p className="text-text-primary font-medium">{formatCurrency(s.unitCostEstimate)}</p>
                            </div>
                            <div>
                              <p className="text-text-muted">Cobertura pós-compra</p>
                              <p className="text-text-primary font-medium">{formatDays(s.postPurchaseCoverageDays)}</p>
                            </div>
                            {s.categoryName && (
                              <div>
                                <p className="text-text-muted">Categoria</p>
                                <p className="text-text-primary font-medium">{s.categoryName}</p>
                              </div>
                            )}
                            {s.isNewProduct && (
                              <div>
                                <p className="text-text-muted">Motivo "Novo"</p>
                                <p className="text-text-primary font-medium">SKU com menos de 30 dias</p>
                              </div>
                            )}
                            {s.policyCurve === 'NO_ABC' && (
                              <div>
                                <p className="text-text-muted">Motivo "Sem ABC"</p>
                                <p className="text-text-primary font-medium">
                                  SKU com 30+ dias sem receita registrada na Curva ABC — política conservadora
                                </p>
                              </div>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  )
}
