'use client'

import { useState, useMemo } from 'react'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { formatDate } from '@/lib/utils/date'

export type AuditIssue = {
  issue_type: string
  severity: string
  entity_type: string
  entity_id: string
  entity_label: string
  description: string
  suggested_action: string
  reference_date: string | null
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

const SEVERITY_LABELS: Record<string, string> = {
  critical: 'Crítico',
  high: 'Alto',
  medium: 'Médio',
}

const SEVERITY_VARIANTS: Record<string, 'error' | 'warning' | 'info'> = {
  critical: 'error',
  high: 'warning',
  medium: 'info',
}

const ISSUE_TYPE_LABELS: Record<string, string> = {
  lot_cost_zero:              'Custo Zero em Lote',
  stock_divergence:           'Divergência de Estoque',
  sale_no_payment:            'Venda Sem Pagamento',
  lot_freight_no_total_cost:  'Frete Sem Custo Total',
  lot_remaining_negative:     'Lote Negativo',
  product_negative_margin:    'Margem Negativa',
  product_no_price:           'Produto Sem Preço',
  variation_no_sku:           'Variação Sem SKU',
  dead_stock:                 'Estoque Parado',
  product_no_supplier:        'Produto Sem Fornecedor',
  product_no_ncm:             'Sem NCM',
  product_no_sale_90d:        'Sem Venda 90d',
  margin_below_target:        'Margem Abaixo do Alvo',
  supplier_inactive:          'Fornecedor Inativo',
}

const ENTITY_TYPE_LABELS: Record<string, string> = {
  stock_lot: 'Lote',
  variation: 'Variação',
  sale:      'Venda',
  product:   'Produto',
}

type FilterButtonProps = {
  active: boolean
  onClick: () => void
  color?: 'critical' | 'high' | 'medium' | 'brand'
  children: React.ReactNode
}

function FilterButton({ active, onClick, color = 'brand', children }: FilterButtonProps) {
  const activeClass =
    color === 'critical' ? 'bg-error/15 border-error/50 text-error' :
    color === 'high'     ? 'bg-warning/15 border-warning/50 text-warning' :
    color === 'medium'   ? 'bg-info/15 border-info/50 text-info' :
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

export function AuditTable({ issues }: { issues: AuditIssue[] }) {
  const [filterSeverity, setFilterSeverity]   = useState('all')
  const [filterEntity,   setFilterEntity]     = useState('all')
  const [filterIssueType, setFilterIssueType] = useState('all')

  const entityTypes = useMemo(
    () => [...new Set(issues.map(i => i.entity_type))].sort(),
    [issues],
  )

  const issueTypes = useMemo(
    () => [...new Set(issues.map(i => i.issue_type))].sort(),
    [issues],
  )

  const filtered = useMemo(() => {
    return issues
      .filter(i => filterSeverity  === 'all' || i.severity    === filterSeverity)
      .filter(i => filterEntity    === 'all' || i.entity_type === filterEntity)
      .filter(i => filterIssueType === 'all' || i.issue_type  === filterIssueType)
      .sort((a, b) => {
        const sev = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
        if (sev !== 0) return sev
        return (b.reference_date ?? '').localeCompare(a.reference_date ?? '')
      })
  }, [issues, filterSeverity, filterEntity, filterIssueType])

  const hasFilters = filterSeverity !== 'all' || filterEntity !== 'all' || filterIssueType !== 'all'

  const clearFilters = () => {
    setFilterSeverity('all')
    setFilterEntity('all')
    setFilterIssueType('all')
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">Problemas Detectados</h3>
          {hasFilters && (
            <button onClick={clearFilters} className="text-xs text-accent hover:underline">
              Limpar filtros ({filtered.length} de {issues.length})
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-2 mt-3">
          {/* Severidade */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-text-muted">Severidade:</span>
            <FilterButton active={filterSeverity === 'all'}      onClick={() => setFilterSeverity('all')}>Todas</FilterButton>
            <FilterButton active={filterSeverity === 'critical'} onClick={() => setFilterSeverity('critical')} color="critical">Crítico</FilterButton>
            <FilterButton active={filterSeverity === 'high'}     onClick={() => setFilterSeverity('high')}     color="high">Alto</FilterButton>
            <FilterButton active={filterSeverity === 'medium'}   onClick={() => setFilterSeverity('medium')}   color="medium">Médio</FilterButton>
          </div>

          {/* Entidade */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-text-muted">Entidade:</span>
            <FilterButton active={filterEntity === 'all'} onClick={() => setFilterEntity('all')}>Todas</FilterButton>
            {entityTypes.map(et => (
              <FilterButton key={et} active={filterEntity === et} onClick={() => setFilterEntity(et)}>
                {ENTITY_TYPE_LABELS[et] ?? et}
              </FilterButton>
            ))}
          </div>

          {/* Tipo do problema */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-text-muted">Tipo:</span>
            <select
              value={filterIssueType}
              onChange={e => setFilterIssueType(e.target.value)}
              className="text-xs px-2.5 py-1 rounded-md border border-border bg-bg-surface text-text-secondary focus:border-brand focus:outline-none cursor-pointer"
            >
              <option value="all">Todos ({issues.length})</option>
              {issueTypes.map(t => (
                <option key={t} value={t}>
                  {ISSUE_TYPE_LABELS[t] ?? t} ({issues.filter(i => i.issue_type === t).length})
                </option>
              ))}
            </select>
          </div>
        </div>
      </CardHeader>

      {issues.length === 0 ? (
        <div className="p-16 text-center space-y-2">
          <p className="text-3xl text-success">✓</p>
          <p className="text-sm font-semibold text-text-primary">Nenhum problema encontrado.</p>
          <p className="text-xs text-text-muted">Dados saudáveis. Continue monitorando regularmente.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-10 text-center text-sm text-text-muted">
          Nenhum problema para os filtros selecionados.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Severidade</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Entidade</TableHead>
                <TableHead>Problema</TableHead>
                <TableHead>Ação Sugerida</TableHead>
                <TableHead align="right">Data Ref.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((issue, idx) => (
                <TableRow key={`${issue.issue_type}-${issue.entity_id}-${idx}`}>
                  <TableCell>
                    <Badge variant={SEVERITY_VARIANTS[issue.severity] ?? 'info'} size="sm">
                      {SEVERITY_LABELS[issue.severity] ?? issue.severity}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-text-muted whitespace-nowrap">
                      {ISSUE_TYPE_LABELS[issue.issue_type] ?? issue.issue_type}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm font-medium text-text-primary block">{issue.entity_label}</span>
                    <span className="text-xs text-text-muted">
                      {ENTITY_TYPE_LABELS[issue.entity_type] ?? issue.entity_type} #{issue.entity_id}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-text-secondary">{issue.description}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-text-muted">{issue.suggested_action}</span>
                  </TableCell>
                  <TableCell align="right" muted>
                    {issue.reference_date ? formatDate(issue.reference_date) : '—'}
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
