import Link from 'next/link'
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { Card, CardHeader } from '@/components/ui/card'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

export const dynamic = 'force-dynamic'

type EntryRow = {
  type: 'income' | 'expense'
  amount: number
  reference_date: string
}

type DayBucket = {
  income: number
  expense: number
}

function currentYearMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthBounds(ym: string): { start: string; end: string } {
  const [y, m] = ym.split('-').map(Number)
  const start = `${ym}-01`
  const lastDay = new Date(y, m, 0).getDate()
  const end = `${ym}-${String(lastDay).padStart(2, '0')}`
  return { start, end }
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('pt-BR', {
    month: 'long',
    year: 'numeric',
  })
}

async function getFlowData(ym: string) {
  const admin = createAdminClient()
  const { start, end } = monthBounds(ym)

  const [periodRes, priorRes] = await Promise.all([
    admin
      .from('finance_entries')
      .select('type, amount, reference_date')
      .gte('reference_date', start)
      .lte('reference_date', end)
      .order('reference_date', { ascending: true }) as unknown as {
        data: EntryRow[] | null
        error: { message: string } | null
      },
    // TODO: otimizar com agregação SQL (SUM) quando volume crescer
    admin
      .from('finance_entries')
      .select('type, amount')
      .lt('reference_date', start) as unknown as {
        data: Pick<EntryRow, 'type' | 'amount'>[] | null
        error: { message: string } | null
      },
  ])

  if (periodRes.error) {
    console.error('Erro ao buscar fluxo:', periodRes.error.message)
    return { rows: [], totalIncome: 0, totalExpense: 0, periodBalance: 0, initialBalance: 0 }
  }

  // Saldo inicial: tudo antes do período
  let initialBalance = 0
  for (const e of priorRes.data ?? []) {
    if (e.type === 'income') initialBalance += Number(e.amount)
    else initialBalance -= Number(e.amount)
  }

  // Agrupar por dia
  const buckets = new Map<string, DayBucket>()
  for (const entry of periodRes.data ?? []) {
    const day = entry.reference_date.slice(0, 10)
    if (!buckets.has(day)) buckets.set(day, { income: 0, expense: 0 })
    const b = buckets.get(day)!
    if (entry.type === 'income') b.income += Number(entry.amount)
    else b.expense += Number(entry.amount)
  }

  // Calcular em ordem crescente (necessário para acumulado correto)
  const sortedDays = Array.from(buckets.keys()).sort()
  let runningBalance = initialBalance
  const rows = sortedDays.map((day) => {
    const { income, expense } = buckets.get(day)!
    const dailyNet = income - expense
    runningBalance += dailyNet
    return { day, income, expense, dailyNet, runningBalance }
  })

  const totalIncome = rows.reduce((s, r) => s + r.income, 0)
  const totalExpense = rows.reduce((s, r) => s + r.expense, 0)
  const periodBalance = totalIncome - totalExpense

  // Inverter para exibição (mais recente no topo)
  rows.reverse()

  return { rows, totalIncome, totalExpense, periodBalance, initialBalance }
}

export default async function FluxoCaixaPage({
  searchParams,
}: {
  searchParams: { month?: string }
}) {
  const ym = /^\d{4}-\d{2}$/.test(searchParams.month ?? '')
    ? searchParams.month!
    : currentYearMonth()

  const { rows, totalIncome, totalExpense, periodBalance, initialBalance } =
    await getFlowData(ym)

  const prevMonth = shiftMonth(ym, -1)
  const nextMonth = shiftMonth(ym, 1)

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/financeiro">
            <button className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
              <ArrowLeft className="w-4 h-4" />
            </button>
          </Link>
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Fluxo de Caixa</h2>
            <p className="text-sm text-text-muted">Baseado em reference_date</p>
          </div>
        </div>

        {/* Navegação de mês */}
        <div className="flex items-center gap-2">
          <Link href={`/financeiro/fluxo?month=${prevMonth}`}>
            <button className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
              <ChevronLeft className="w-4 h-4" />
            </button>
          </Link>
          <span className="text-sm font-medium text-text-primary capitalize w-36 text-center">
            {monthLabel(ym)}
          </span>
          <Link href={`/financeiro/fluxo?month=${nextMonth}`}>
            <button className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
              <ChevronRight className="w-4 h-4" />
            </button>
          </Link>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-4">
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Total de Entradas</p>
          <p className="text-xl font-bold text-success">{formatCurrency(totalIncome)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Total de Saídas</p>
          <p className="text-xl font-bold text-error">{formatCurrency(totalExpense)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Saldo do Período</p>
          <p className={`text-xl font-bold ${periodBalance >= 0 ? 'text-success' : 'text-error'}`}>
            {formatCurrency(periodBalance)}
          </p>
        </div>
      </div>

      <Card>
        {/* Saldo inicial */}
        <div className="px-5 pt-4 pb-2 border-b border-border">
          <p className="text-xs text-text-muted">
            Saldo inicial do período:{' '}
            <span className={`font-semibold ${initialBalance >= 0 ? 'text-text-primary' : 'text-error'}`}>
              {formatCurrency(initialBalance)}
            </span>
          </p>
        </div>

        {rows.length === 0 ? (
          <div className="py-12 text-center text-sm text-text-muted">
            Nenhum lançamento neste período.
          </div>
        ) : (
          <>
            <CardHeader>
              <p className="text-xs text-text-muted">{rows.length} dias com movimentação</p>
            </CardHeader>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead align="right">Entradas</TableHead>
                    <TableHead align="right">Saídas</TableHead>
                    <TableHead align="right">Saldo do Dia</TableHead>
                    <TableHead align="right">Saldo Acumulado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.day}>
                      <TableCell>{formatDate(row.day)}</TableCell>
                      <TableCell align="right" className="text-success">
                        {row.income > 0 ? formatCurrency(row.income) : '—'}
                      </TableCell>
                      <TableCell align="right" className="text-error">
                        {row.expense > 0 ? formatCurrency(row.expense) : '—'}
                      </TableCell>
                      <TableCell
                        align="right"
                        className={`font-semibold ${row.dailyNet >= 0 ? 'text-success' : 'text-error'}`}
                      >
                        {row.dailyNet >= 0 ? '+' : '−'} {formatCurrency(Math.abs(row.dailyNet))}
                      </TableCell>
                      <TableCell
                        align="right"
                        className={`font-bold ${row.runningBalance >= 0 ? 'text-text-primary' : 'text-error'}`}
                      >
                        {formatCurrency(row.runningBalance)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
