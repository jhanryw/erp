import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

export const dynamic = 'force-dynamic'

async function getFinancialData() {
  const supabase = createClient()
  const [monthlyRes, entriesRes] = await Promise.all([
    supabase
      .from('mv_monthly_financial')
      .select('*')
      .order('month', { ascending: false })
      .limit(12) as unknown as Promise<{ data: any[] | null }>,
    supabase
      .from('finance_entries')
      .select('id, type, category, description, amount, reference_date')
      .order('reference_date', { ascending: false })
      .limit(50) as unknown as Promise<{ data: any[] | null }>,
  ])
  return {
    months: monthlyRes.data ?? [],
    entries: entriesRes.data ?? [],
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  sale: 'Venda', cashback_used: 'Cashback', other_income: 'Outra Receita',
  stock_purchase: 'Compra Estoque', freight_cost: 'Frete', marketing: 'Marketing',
  rent: 'Aluguel', salaries: 'Salários', operational: 'Operacional',
  taxes: 'Impostos', other_expense: 'Outra Despesa',
}

export default async function RelatorioFinanceiroPage() {
  const { months, entries } = await getFinancialData()
  const current = months[0]

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/relatorios">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Relatório Financeiro</h2>
          <p className="text-sm text-text-muted">DRE por competência</p>
        </div>
      </div>

      {/* DRE Detalhada do mês atual */}
      {current && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">
              DRE — {formatDate(current.month, 'MMMM yyyy')}
            </h3>
          </CardHeader>
          <div className="p-5 space-y-1 text-sm">
            {[
              { label: '(+) Receita de Vendas', value: current.revenue_sales ?? 0, bold: false },
              { label: '(+) Outras Receitas', value: current.revenue_other ?? 0, bold: false },
              { label: '= Receita Total', value: current.total_income ?? 0, bold: true, className: 'text-success' },
              null,
              { label: '(-) CMV — Compra de Estoque', value: -(current.exp_stock ?? 0), bold: false },
              { label: '(-) Frete', value: -(current.exp_freight ?? 0), bold: false },
              { label: '(-) Marketing', value: -(current.exp_marketing ?? 0), bold: false },
              { label: '(-) Aluguel', value: -(current.exp_rent ?? 0), bold: false },
              { label: '(-) Salários', value: -(current.exp_salaries ?? 0), bold: false },
              { label: '(-) Operacional', value: -(current.exp_operational ?? 0), bold: false },
              { label: '(-) Impostos', value: -(current.exp_taxes ?? 0), bold: false },
              { label: '(-) Outras Despesas', value: -(current.exp_other ?? 0), bold: false },
              { label: '= Total Despesas', value: -(current.total_expenses ?? 0), bold: true, className: 'text-error' },
              null,
              { label: '= Resultado Líquido', value: current.net_result ?? 0, bold: true, className: (current.net_result ?? 0) >= 0 ? 'text-success' : 'text-error' },
            ].map((row, i) => {
              if (!row) return <div key={i} className="border-t border-border my-2" />
              const formatted = row.value < 0 ? `- ${formatCurrency(Math.abs(row.value))}` : formatCurrency(Math.abs(row.value))
              return (
                <div key={row.label} className={`flex justify-between py-1 ${row.bold ? 'font-semibold border-t border-border pt-2' : ''}`}>
                  <span className={row.bold ? 'text-text-primary' : 'text-text-secondary'}>{row.label}</span>
                  <span className={row.className ?? 'text-text-primary'}>{row.value === 0 ? '—' : formatted}</span>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Histórico 12 meses */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">Histórico — Últimos 12 Meses</h3>
        </CardHeader>
        {months.length === 0 ? (
          <div className="p-12 text-center text-sm text-text-muted">Nenhum lançamento financeiro registrado</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mês</TableHead>
                <TableHead align="right">Receita</TableHead>
                <TableHead align="right">CMV</TableHead>
                <TableHead align="right">Marketing</TableHead>
                <TableHead align="right">Outras Desp.</TableHead>
                <TableHead align="right">Total Desp.</TableHead>
                <TableHead align="right">Resultado</TableHead>
                <TableHead align="right">Margem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {months.map((m) => {
                const otherExp = (m.exp_rent ?? 0) + (m.exp_salaries ?? 0) + (m.exp_operational ?? 0) + (m.exp_taxes ?? 0) + (m.exp_other ?? 0) + (m.exp_freight ?? 0)
                const margin = m.total_income > 0 ? (m.net_result / m.total_income) * 100 : 0
                return (
                  <TableRow key={m.month}>
                    <TableCell className="font-medium capitalize">{formatDate(m.month, 'MMM yyyy')}</TableCell>
                    <TableCell align="right" className="text-success font-semibold">{formatCurrency(m.total_income)}</TableCell>
                    <TableCell align="right" muted>{formatCurrency(m.exp_stock ?? 0)}</TableCell>
                    <TableCell align="right" muted>{formatCurrency(m.exp_marketing ?? 0)}</TableCell>
                    <TableCell align="right" muted>{formatCurrency(otherExp)}</TableCell>
                    <TableCell align="right" className="text-error">{formatCurrency(m.total_expenses)}</TableCell>
                    <TableCell align="right">
                      <span className={`font-bold ${m.net_result >= 0 ? 'text-success' : 'text-error'}`}>
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
        )}
      </Card>

      {/* Lançamentos Recentes */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">Lançamentos Recentes</h3>
        </CardHeader>
        {entries.length === 0 ? (
          <div className="p-8 text-center text-sm text-text-muted">Nenhum lançamento</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Categoria</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead align="right">Valor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell muted>{formatDate(e.reference_date)}</TableCell>
                  <TableCell muted>{CATEGORY_LABELS[e.category] ?? e.category}</TableCell>
                  <TableCell>{e.description}</TableCell>
                  <TableCell align="right">
                    <span className={`font-semibold ${e.type === 'income' ? 'text-success' : 'text-error'}`}>
                      {e.type === 'income' ? '+' : '-'} {formatCurrency(e.amount)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  )
}
