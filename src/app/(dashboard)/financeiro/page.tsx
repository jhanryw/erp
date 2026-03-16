import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { DollarSign, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { formatCurrency, formatDate as fmtDate } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

async function getFinancialData() {
  const supabase = createClient()
  const { data: months } = await supabase
    .from('mv_monthly_financial')
    .select('*')
    .order('month', { ascending: false })
    .limit(12)

  const current = months?.[0]
  const previous = months?.[1]

  return {
    current,
    previous,
    months: months ?? [],
  }
}

function trendPct(current: number, previous: number): number | undefined {
  if (!previous) return undefined
  return ((current - previous) / previous) * 100
}

export default async function FinanceiroPage() {
  const { current, previous, months } = await getFinancialData()

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Financeiro</h2>
          <p className="text-sm text-text-muted">Regime de competência</p>
        </div>
        <div className="flex gap-2">
          <Link href="/financeiro/fluxo"><Button variant="secondary" size="sm">Fluxo de Caixa</Button></Link>
          <Link href="/financeiro/dre"><Button variant="secondary" size="sm">DRE Completo</Button></Link>
          <Link href="/financeiro/lancamentos/novo"><Button size="sm"><DollarSign className="w-4 h-4" />Lançamento</Button></Link>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Receita do Mês"
          value={formatCurrency(current?.total_income ?? 0)}
          trend={previous ? { value: trendPct(current?.total_income ?? 0, previous.total_income) ?? 0, label: 'vs mês anterior' } : undefined}
          icon={<TrendingUp className="w-4 h-4" />}
        />
        <StatCard
          title="Despesas do Mês"
          value={formatCurrency(current?.total_expenses ?? 0)}
          trend={previous ? { value: trendPct(current?.total_expenses ?? 0, previous.total_expenses) ?? 0, label: 'vs mês anterior' } : undefined}
          icon={<TrendingDown className="w-4 h-4" />}
        />
        <StatCard
          title="CMV (Custo Mercadoria)"
          value={formatCurrency(current?.exp_stock ?? 0)}
          subtitle="custo dos produtos vendidos"
        />
        <StatCard
          title="Lucro Líquido"
          value={formatCurrency(current?.net_result ?? 0)}
          valueClassName={(current?.net_result ?? 0) >= 0 ? 'text-success' : 'text-error'}
          icon={<DollarSign className="w-4 h-4" />}
        />
      </div>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">DRE — Últimos 12 meses</h3>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mês</TableHead>
              <TableHead align="right">Receita</TableHead>
              <TableHead align="right">CMV</TableHead>
              <TableHead align="right">Despesas Op.</TableHead>
              <TableHead align="right">Lucro Líquido</TableHead>
              <TableHead align="right">Margem %</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {months.map((m) => {
              const opex = (m.exp_marketing ?? 0) + (m.exp_rent ?? 0) + (m.exp_salaries ?? 0) + (m.exp_operational ?? 0) + (m.exp_taxes ?? 0) + (m.exp_other ?? 0)
              const margin = m.total_income > 0 ? (m.net_result / m.total_income) * 100 : 0
              return (
                <TableRow key={m.month}>
                  <TableCell className="font-medium capitalize">{formatDate(m.month, 'MMM yyyy')}</TableCell>
                  <TableCell align="right">{formatCurrency(m.total_income)}</TableCell>
                  <TableCell align="right" muted>{formatCurrency(m.exp_stock ?? 0)}</TableCell>
                  <TableCell align="right" muted>{formatCurrency(opex)}</TableCell>
                  <TableCell align="right">
                    <span className={`font-semibold ${m.net_result >= 0 ? 'text-success' : 'text-error'}`}>
                      {formatCurrency(m.net_result)}
                    </span>
                  </TableCell>
                  <TableCell align="right">
                    <span className={`text-sm ${margin >= 20 ? 'text-success' : margin >= 10 ? 'text-warning' : 'text-error'}`}>
                      {margin.toFixed(1)}%
                    </span>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
