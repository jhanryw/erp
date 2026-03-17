import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { Plus, TrendingUp } from 'lucide-react'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import { subDays } from 'date-fns'

const CATEGORY_LABELS: Record<string, string> = {
  paid_traffic: 'Tráfego Pago', influencers: 'Influenciadores', events: 'Eventos',
  photos: 'Fotos/Conteúdo', gifts: 'Brindes', packaging: 'Embalagens',
  rent: 'Aluguel', salaries: 'Salários', operational: 'Operacional',
  taxes: 'Impostos', other: 'Outros',
}

async function getMarketingData() {
  const supabase = createClient()
  const thirtyDaysAgo = subDays(new Date(), 30).toISOString().split('T')[0]

  const [costs, campaigns] = await Promise.all([
    supabase.from('marketing_costs').select('*').gte('cost_date', thirtyDaysAgo).order('cost_date', { ascending: false }) as unknown as Promise<{ data: any[] | null, error: any }>,
    supabase.from('campaigns').select('*').eq('active', true).limit(5) as unknown as Promise<{ data: any[] | null, error: any }>,
  ])

  const costData = costs.data ?? []
  const total = costData.reduce((s, c) => s + c.amount, 0)
  const byCategory = costData.reduce((acc, c) => {
    acc[c.category] = (acc[c.category] ?? 0) + c.amount
    return acc
  }, {} as Record<string, number>)

  return { costs: costData, campaigns: campaigns.data ?? [], total, byCategory }
}

export default async function MarketingPage() {
  const { costs, campaigns, total, byCategory } = await getMarketingData()

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Marketing</h2>
          <p className="text-sm text-text-muted">Últimos 30 dias</p>
        </div>
        <div className="flex gap-2">
          <Link href="/marketing/campanhas"><Button variant="secondary" size="sm">Campanhas</Button></Link>
          <Link href="/marketing/custos"><Button variant="secondary" size="sm">Ver Custos</Button></Link>
          <Link href="/marketing/custos/novo"><Button size="sm"><Plus className="w-4 h-4" />Lançar Custo</Button></Link>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard title="Investimento Total" value={formatCurrency(total)} subtitle="últimos 30 dias" icon={<TrendingUp className="w-4 h-4" />} />
        <StatCard title="Campanhas Ativas" value={campaigns.length} subtitle="em andamento" />
        <StatCard title="CAC" value="—" subtitle="Configure clientes por período" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Custos recentes */}
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Custos Recentes</h3>
          </CardHeader>
          {costs.length === 0 ? (
            <div className="p-8 text-center text-sm text-text-muted">Nenhum custo registrado</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead align="right">Valor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {costs.slice(0, 8).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell muted>{formatDate(c.cost_date)}</TableCell>
                    <TableCell>
                      <Badge variant="default" size="sm">{CATEGORY_LABELS[c.category] ?? c.category}</Badge>
                    </TableCell>
                    <TableCell align="right" className="font-semibold">{formatCurrency(c.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        {/* Por categoria */}
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Por Categoria</h3>
          </CardHeader>
          <div className="p-5 space-y-3">
            {(Object.entries(byCategory) as [string, number][])
              .sort(([, a], [, b]) => b - a)
              .map(([cat, val]) => (
                <div key={cat}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-text-secondary">{CATEGORY_LABELS[cat] ?? cat}</span>
                    <span className="font-semibold text-text-primary">{formatCurrency(val)}</span>
                  </div>
                  <div className="h-1.5 bg-bg-overlay rounded-full">
                    <div className="h-full bg-brand rounded-full" style={{ width: `${(val / total) * 100}%` }} />
                  </div>
                </div>
              ))}
            {Object.keys(byCategory).length === 0 && (
              <p className="text-sm text-text-muted text-center py-4">Sem dados</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}
