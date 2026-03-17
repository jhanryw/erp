import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

export const dynamic = 'force-dynamic'

const CATEGORY_LABELS: Record<string, string> = {
  paid_traffic: 'Tráfego Pago', influencers: 'Influenciadores', events: 'Eventos',
  photos: 'Fotos/Conteúdo', gifts: 'Brindes', packaging: 'Embalagens',
  rent: 'Aluguel', salaries: 'Salários', operational: 'Operacional',
  taxes: 'Impostos', other: 'Outros',
}

async function getMarketingData() {
  const supabase = createClient()
  const { data } = await supabase
    .from('marketing_costs')
    .select('id, category, description, amount, cost_date, is_recurring, notes')
    .order('cost_date', { ascending: false })
    .limit(200) as unknown as { data: any[] | null }
  return data ?? []
}

export default async function RelatorioMarketingPage() {
  const costs = await getMarketingData()

  const total = costs.reduce((s, c) => s + (c.amount ?? 0), 0)
  const recurring = costs.filter(c => c.is_recurring).reduce((s, c) => s + c.amount, 0)

  const byCategory = costs.reduce((acc: Record<string, number>, c) => {
    acc[c.category] = (acc[c.category] ?? 0) + c.amount
    return acc
  }, {})

  const byMonth = costs.reduce((acc: Record<string, number>, c) => {
    const month = c.cost_date?.substring(0, 7) ?? '—'
    acc[month] = (acc[month] ?? 0) + c.amount
    return acc
  }, {})

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/relatorios">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Relatório de Marketing</h2>
          <p className="text-sm text-text-muted">{costs.length} lançamentos</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        {[
          { label: 'Investimento Total', value: formatCurrency(total) },
          { label: 'Recorrente (Mensal)', value: formatCurrency(recurring) },
          { label: 'Categorias', value: Object.keys(byCategory).length },
        ].map((kpi) => (
          <div key={kpi.label} className="card p-4">
            <p className="text-xs text-text-muted mb-1">{kpi.label}</p>
            <p className="text-xl font-bold text-text-primary">{kpi.value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Por categoria */}
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Por Categoria</h3>
          </CardHeader>
          <div className="p-5 space-y-3">
            {(Object.entries(byCategory) as [string, number][]).sort(([, a], [, b]) => b - a).map(([cat, val]) => (
              <div key={cat}>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-text-secondary">{CATEGORY_LABELS[cat] ?? cat}</span>
                  <span className="font-semibold text-text-primary">{formatCurrency(val)}</span>
                </div>
                <div className="h-1.5 bg-bg-overlay rounded-full">
                  <div className="h-full bg-brand rounded-full" style={{ width: total > 0 ? `${(val / total) * 100}%` : '0%' }} />
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Por mês */}
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Por Mês</h3>
          </CardHeader>
          <div className="p-5 space-y-3">
            {(Object.entries(byMonth) as [string, number][]).sort(([a], [b]) => b.localeCompare(a)).slice(0, 12).map(([month, val]) => (
              <div key={month} className="flex justify-between text-sm">
                <span className="text-text-secondary capitalize">{month}</span>
                <span className="font-semibold text-text-primary">{formatCurrency(val)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Lista completa */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">Todos os Lançamentos</h3>
        </CardHeader>
        {costs.length === 0 ? (
          <div className="p-12 text-center text-sm text-text-muted">Nenhum custo registrado</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Categoria</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead align="center">Recorrente</TableHead>
                <TableHead align="right">Valor</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {costs.map((c) => (
                <TableRow key={c.id}>
                  <TableCell muted>{formatDate(c.cost_date)}</TableCell>
                  <TableCell>
                    <Badge variant="default" size="sm">{CATEGORY_LABELS[c.category] ?? c.category}</Badge>
                  </TableCell>
                  <TableCell className="max-w-xs truncate">{c.description}</TableCell>
                  <TableCell align="center">
                    {c.is_recurring ? <Badge variant="info" size="sm">Sim</Badge> : <span className="text-xs text-text-muted">—</span>}
                  </TableCell>
                  <TableCell align="right" className="font-semibold">{formatCurrency(c.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  )
}
