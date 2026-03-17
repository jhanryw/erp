import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { Plus, TrendingUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import { DeleteCostButton } from './_components/delete-cost-button'

const CATEGORY_LABELS: Record<string, string> = {
  paid_traffic: 'Tráfego Pago',
  influencers: 'Influenciadores',
  events: 'Eventos',
  photos: 'Fotos/Conteúdo',
  gifts: 'Brindes',
  packaging: 'Embalagens',
  rent: 'Aluguel',
  salaries: 'Salários',
  operational: 'Operacional',
  taxes: 'Impostos',
  other: 'Outros',
}

async function getCosts() {
  const supabase = createClient()
  const { data } = await supabase
    .from('marketing_costs')
    .select('id, category, description, amount, cost_date, is_recurring, notes')
    .order('cost_date', { ascending: false })
    .limit(100) as unknown as { data: any[] | null }
  return data ?? []
}

export default async function CustosMarketingPage() {
  const costs = await getCosts()

  const total = costs.reduce((s, c) => s + (c.amount ?? 0), 0)
  const recurring = costs.filter(c => c.is_recurring).reduce((s, c) => s + c.amount, 0)
  const recurringCount = costs.filter(c => c.is_recurring).length

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Custos de Marketing</h2>
          <p className="text-sm text-text-muted">{costs.length} lançamentos</p>
        </div>
        <div className="flex gap-2">
          <Link href="/marketing">
            <Button variant="secondary" size="sm">← Marketing</Button>
          </Link>
          <Link href="/marketing/custos/novo">
            <Button size="sm">
              <Plus className="w-4 h-4" />
              Lançar Custo
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Investimento Total</p>
          <p className="text-xl font-bold text-text-primary">{formatCurrency(total)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Custos Recorrentes</p>
          <p className="text-xl font-bold text-text-primary">{formatCurrency(recurring)}</p>
          <p className="text-xs text-text-muted mt-0.5">{recurringCount} lançamentos</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Não Recorrentes</p>
          <p className="text-xl font-bold text-text-primary">{formatCurrency(total - recurring)}</p>
          <p className="text-xs text-text-muted mt-0.5">{costs.length - recurringCount} lançamentos</p>
        </div>
      </div>

      <Card>
        {costs.length === 0 ? (
          <EmptyState
            icon={<TrendingUp className="w-6 h-6 text-text-muted" />}
            title="Nenhum custo de marketing registrado"
            description="Lance custos de marketing para acompanhar seus investimentos."
            action={{ label: 'Lançar Custo', href: '/marketing/custos/novo' }}
          />
        ) : (
          <>
            <CardHeader>
              <p className="text-xs text-text-muted">{costs.length} lançamentos (últimos 100)</p>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead>Descrição</TableHead>
                  <TableHead align="center">Recorrente</TableHead>
                  <TableHead align="right">Valor</TableHead>
                  <TableHead align="center">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {costs.map((cost) => (
                  <TableRow key={cost.id}>
                    <TableCell muted>{formatDate(cost.cost_date)}</TableCell>
                    <TableCell>
                      <Badge variant="default" size="sm">{CATEGORY_LABELS[cost.category] ?? cost.category}</Badge>
                    </TableCell>
                    <TableCell className="max-w-xs">
                      <span className="truncate block">{cost.description}</span>
                    </TableCell>
                    <TableCell align="center">
                      {cost.is_recurring
                        ? <Badge variant="info" size="sm">Sim</Badge>
                        : <span className="text-xs text-text-muted">—</span>
                      }
                    </TableCell>
                    <TableCell align="right" className="font-semibold">
                      {formatCurrency(cost.amount)}
                    </TableCell>
                    <TableCell align="center">
                      <div className="flex items-center justify-center gap-1">
                        <Link href={`/marketing/custos/${cost.id}/editar`}>
                          <Button variant="ghost" size="sm" className="text-xs px-2">Editar</Button>
                        </Link>
                        <DeleteCostButton id={cost.id} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Card>
    </div>
  )
}
