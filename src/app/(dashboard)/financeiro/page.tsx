import Link from 'next/link'
import { DollarSign, TrendingUp, TrendingDown, Minus } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

export const dynamic = 'force-dynamic'

type MonthlyFinancialRow = {
  month: string
  total_income: number | null
  exp_stock: number | null
  exp_marketing: number | null
  exp_rent: number | null
  exp_salaries: number | null
  exp_operational: number | null
  exp_taxes: number | null
  exp_other: number | null
  net_result: number | null
}

async function getFinancialData() {
  const supabase = createAdminClient()

  const { data: months, error } = await supabase
    .from('mv_monthly_financial')
    .select('*')
    .order('month', { ascending: false })
    .limit(12)

  if (error) {
    console.error('Erro ao listar financeiro:', error.message)
  }

  const rows = (months ?? []) as MonthlyFinancialRow[]
  const current = rows[0] ?? null
  const previous = rows[1] ?? null

  return {
    current,
    previous,
    months: rows,
  }
}

function trendPct(
  current: number,
  previous: number
): { value: number; label?: string } | undefined {
  if (!previous) return undefined

  return {
    value: ((current - previous) / previous) * 100,
    label: 'vs mês anterior',
  }
}

export default async function FinanceiroPage() {
  const { current, previous, months } = await getFinancialData()

  const currentIncome = Number(current?.total_income ?? 0)
  const currentStock = Number(current?.exp_stock ?? 0)
  const currentNet = Number(current?.net_result ?? 0)

  const previousIncome = Number(previous?.total_income ?? 0)
  const previousStock = Number(previous?.exp_stock ?? 0)
  const previousNet = Number(previous?.net_result ?? 0)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Financeiro</h1>
          <p className="text-sm text-muted-foreground">Regime de competência</p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link href="/financeiro/fluxo">
            <Button variant="outline">Fluxo de Caixa</Button>
          </Link>

          <Link href="/financeiro/lucro">
            <Button variant="outline">Lucro por Venda</Button>
          </Link>

          <Link href="/financeiro/ranking">
            <Button variant="outline">Ranking de Produtos</Button>
          </Link>

          <Link href="/financeiro/clientes">
            <Button variant="outline">Lucro por Cliente</Button>
          </Link>

          <Link href="/financeiro/dre">
            <Button variant="outline">DRE Completo</Button>
          </Link>

          <Link href="/financeiro/lancamentos">
            <Button variant="outline">Ver Lançamentos</Button>
          </Link>

          <Link href="/financeiro/lancamentos/novo">
            <Button>Lançamento</Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Receita do Mês"
          value={formatCurrency(currentIncome)}
          icon={<TrendingUp className="h-4 w-4" />}
          trend={previous ? trendPct(currentIncome, previousIncome) : undefined}
        />

        <StatCard
          title="CMV do Mês"
          value={formatCurrency(currentStock)}
          icon={<TrendingDown className="h-4 w-4" />}
          trend={previous ? trendPct(currentStock, previousStock) : undefined}
        />

        <StatCard
          title="Resultado Líquido"
          value={formatCurrency(currentNet)}
          icon={
            currentNet >= 0 ? (
              <DollarSign className="h-4 w-4" />
            ) : (
              <Minus className="h-4 w-4" />
            )
          }
          valueClassName={currentNet >= 0 ? 'text-success' : 'text-error'}
          trend={previous ? trendPct(currentNet, previousNet) : undefined}
        />

        <StatCard
          title="Margem Líquida"
          value={
            currentIncome > 0
              ? `${((currentNet / currentIncome) * 100).toFixed(1)}%`
              : '0,0%'
          }
          icon={
            currentNet >= 0 ? (
              <TrendingUp className="h-4 w-4" />
            ) : (
              <TrendingDown className="h-4 w-4" />
            )
          }
          valueClassName={currentNet >= 0 ? 'text-success' : 'text-error'}
        />
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">DRE — Últimos 12 meses</h2>
        </CardHeader>

        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mês</TableHead>
                <TableHead>Receita</TableHead>
                <TableHead>CMV</TableHead>
                <TableHead>Despesas Op.</TableHead>
                <TableHead>Lucro Líquido</TableHead>
                <TableHead>Margem %</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {months.map((m) => {
                const income = Number(m.total_income ?? 0)
                const stock = Number(m.exp_stock ?? 0)
                const opex =
                  Number(m.exp_marketing ?? 0) +
                  Number(m.exp_rent ?? 0) +
                  Number(m.exp_salaries ?? 0) +
                  Number(m.exp_operational ?? 0) +
                  Number(m.exp_taxes ?? 0) +
                  Number(m.exp_other ?? 0)

                const net = Number(m.net_result ?? 0)
                const margin = income > 0 ? (net / income) * 100 : 0

                return (
                  <TableRow key={m.month}>
                    <TableCell>{formatDate(m.month, 'MMM yyyy')}</TableCell>
                    <TableCell>{formatCurrency(income)}</TableCell>
                    <TableCell>{formatCurrency(stock)}</TableCell>
                    <TableCell>{formatCurrency(opex)}</TableCell>
                    <TableCell
                      className={net >= 0 ? 'text-success' : 'text-error'}
                    >
                      {formatCurrency(net)}
                    </TableCell>
                    <TableCell
                      className={
                        margin >= 20
                          ? 'text-success'
                          : margin >= 10
                          ? 'text-warning'
                          : 'text-error'
                      }
                    >
                      {margin.toFixed(1)}%
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}