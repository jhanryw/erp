'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Select } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate, formatDateTime } from '@/lib/utils/date'
import { CheckCircle2, XCircle, DollarSign } from 'lucide-react'

export type PendingMovement = {
  id: number
  description: string
  amount: number
  method: string
  createdAt: string
  cashSessionId: number
  userName: string
  confirmedDuplicate: {
    financeEntryId: number
    description: string
    amount: number
    category: string
    referenceDate: string
  } | null
}

const EXPENSE_CATEGORIES = [
  { value: 'stock_purchase', label: 'Compra de Estoque' },
  { value: 'freight_cost', label: 'Frete' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'rent', label: 'Aluguel' },
  { value: 'salaries', label: 'Salários' },
  { value: 'operational', label: 'Operacional' },
  { value: 'taxes', label: 'Impostos' },
  { value: 'other_expense', label: 'Outra Despesa' },
]

const METHOD_LABELS: Record<string, string> = {
  cash: 'Dinheiro',
  pix: 'PIX',
  credit_card: 'Crédito',
  debit_card: 'Débito',
  card: 'Cartão legado',
}

type RowState = {
  category: string
  referenceDate: string
  selected: boolean
  status: 'idle' | 'loading' | 'success' | 'error'
  message?: string
}

function toDateInput(iso: string): string {
  return iso.slice(0, 10)
}

async function regularizar(payload: {
  cash_movement_id: number
  finance_entry_id?: number
  category?: string
  reference_date?: string
}) {
  const res = await fetch('/api/admin/financeiro/regularizacao-caixa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : 'Erro ao regularizar.')
  return json.result
}

export function RegularizacaoTable({ movements }: { movements: PendingMovement[] }) {
  const [rows, setRows] = useState<Record<number, RowState>>(() =>
    Object.fromEntries(
      movements.map((m) => [
        m.id,
        {
          category: '',
          referenceDate: toDateInput(m.createdAt),
          selected: false,
          status: 'idle' as const,
        },
      ])
    )
  )
  const [done, setDone] = useState<Set<number>>(new Set())
  const [bulkRunning, setBulkRunning] = useState(false)

  const regularizableMovements = movements.filter((m) => !m.confirmedDuplicate && !done.has(m.id))
  const selectedCount = regularizableMovements.filter((m) => rows[m.id]?.selected).length
  const allSelected = regularizableMovements.length > 0 && selectedCount === regularizableMovements.length

  function updateRow(id: number, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }

  function toggleAll() {
    const next = !allSelected
    setRows((prev) => {
      const copy = { ...prev }
      for (const m of regularizableMovements) {
        copy[m.id] = { ...copy[m.id], selected: next }
      }
      return copy
    })
  }

  async function regularizarLinha(movement: PendingMovement) {
    const row = rows[movement.id]
    if (!row.category || !row.referenceDate) {
      updateRow(movement.id, { status: 'error', message: 'Categoria e competência são obrigatórias.' })
      return
    }
    updateRow(movement.id, { status: 'loading', message: undefined })
    try {
      await regularizar({
        cash_movement_id: movement.id,
        category: row.category,
        reference_date: row.referenceDate,
      })
      updateRow(movement.id, { status: 'success' })
      setDone((prev) => new Set(prev).add(movement.id))
      toast.success(`Movimento #${movement.id} regularizado.`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro inesperado.'
      updateRow(movement.id, { status: 'error', message })
      toast.error(`Movimento #${movement.id} falhou`, { description: message })
    }
  }

  async function vincularDuplicata(movement: PendingMovement) {
    if (!movement.confirmedDuplicate) return
    updateRow(movement.id, { status: 'loading', message: undefined })
    try {
      await regularizar({
        cash_movement_id: movement.id,
        finance_entry_id: movement.confirmedDuplicate.financeEntryId,
      })
      updateRow(movement.id, { status: 'success' })
      setDone((prev) => new Set(prev).add(movement.id))
      toast.success(`Movimento #${movement.id} vinculado ao lançamento #${movement.confirmedDuplicate.financeEntryId}.`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro inesperado.'
      updateRow(movement.id, { status: 'error', message })
      toast.error(`Vínculo do movimento #${movement.id} falhou`, { description: message })
    }
  }

  async function regularizarSelecionadas() {
    const selected = regularizableMovements.filter((m) => rows[m.id]?.selected)
    if (selected.length === 0) return
    setBulkRunning(true)
    // Chamadas independentes — uma falha não impede as demais.
    await Promise.allSettled(selected.map((m) => regularizarLinha(m)))
    setBulkRunning(false)
  }

  if (movements.length === 0) {
    return (
      <EmptyState
        icon={<DollarSign className="w-6 h-6 text-text-muted" />}
        title="Nenhuma pendência"
        description="Todas as despesas históricas do Caixa já foram regularizadas."
      />
    )
  }

  return (
    <div className="space-y-0">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border">
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            disabled={regularizableMovements.length === 0}
          />
          Selecionar todas ({regularizableMovements.length})
        </label>
        <Button
          size="sm"
          onClick={regularizarSelecionadas}
          loading={bulkRunning}
          disabled={selectedCount === 0}
        >
          Regularizar selecionadas ({selectedCount})
        </Button>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead></TableHead>
              <TableHead>Descrição</TableHead>
              <TableHead align="right">Valor</TableHead>
              <TableHead>Data</TableHead>
              <TableHead>Método</TableHead>
              <TableHead>Usuário</TableHead>
              <TableHead>Sessão</TableHead>
              <TableHead>Status / Ação</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {movements.map((m) => {
              const row = rows[m.id]
              const isDone = done.has(m.id)

              return (
                <TableRow key={m.id}>
                  <TableCell>
                    {!m.confirmedDuplicate && !isDone && (
                      <input
                        type="checkbox"
                        checked={row.selected}
                        onChange={(e) => updateRow(m.id, { selected: e.target.checked })}
                      />
                    )}
                  </TableCell>
                  <TableCell className="max-w-xs">
                    <span className="truncate block">{m.description}</span>
                    <span className="text-xs text-text-muted">#{m.id}</span>
                  </TableCell>
                  <TableCell align="right" className="text-error font-semibold">
                    {formatCurrency(m.amount)}
                  </TableCell>
                  <TableCell muted>{formatDateTime(m.createdAt)}</TableCell>
                  <TableCell muted>{METHOD_LABELS[m.method] ?? m.method}</TableCell>
                  <TableCell muted>{m.userName}</TableCell>
                  <TableCell muted>
                    <a href={`/caixa/historico/${m.cashSessionId}`} className="hover:underline">
                      #{m.cashSessionId}
                    </a>
                  </TableCell>
                  <TableCell>
                    {isDone ? (
                      <span className="flex items-center gap-1.5 text-success text-sm">
                        <CheckCircle2 className="w-4 h-4" /> Regularizado
                      </span>
                    ) : m.confirmedDuplicate ? (
                      <div className="space-y-2 py-2 min-w-[260px]">
                        <Badge variant="warning" size="sm">Possível duplicidade confirmada</Badge>
                        <p className="text-xs text-text-secondary">
                          Lançamento #{m.confirmedDuplicate.financeEntryId} — {m.confirmedDuplicate.description} —{' '}
                          {formatCurrency(m.confirmedDuplicate.amount)} ({formatDate(m.confirmedDuplicate.referenceDate)})
                        </p>
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={row.status === 'loading'}
                          onClick={() => vincularDuplicata(m)}
                        >
                          Vincular ao lançamento #{m.confirmedDuplicate.financeEntryId}
                        </Button>
                        {row.status === 'error' && (
                          <p className="flex items-center gap-1 text-xs text-error">
                            <XCircle className="w-3.5 h-3.5" /> {row.message}
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-2 py-2 min-w-[260px]">
                        <Select
                          value={row.category}
                          onChange={(e) => updateRow(m.id, { category: e.target.value })}
                        >
                          <option value="">Categoria...</option>
                          {EXPENSE_CATEGORIES.map((c) => (
                            <option key={c.value} value={c.value}>{c.label}</option>
                          ))}
                        </Select>
                        <Input
                          type="date"
                          value={row.referenceDate}
                          onChange={(e) => updateRow(m.id, { referenceDate: e.target.value })}
                        />
                        <Button
                          size="sm"
                          loading={row.status === 'loading'}
                          onClick={() => regularizarLinha(m)}
                        >
                          Regularizar
                        </Button>
                        {row.status === 'error' && (
                          <p className="flex items-center gap-1 text-xs text-error">
                            <XCircle className="w-3.5 h-3.5" /> {row.message}
                          </p>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
