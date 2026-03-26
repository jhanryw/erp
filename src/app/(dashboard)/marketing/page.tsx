import Link from 'next/link'
import { Plus, TrendingUp } from 'lucide-react'
import { subDays } from 'date-fns'

import { createAdminClient } from '@/lib/supabase/admin'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader } from '@/components/ui/card'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

export const dynamic = 'force-dynamic'

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

type MarketingCostRow = {
  id: number
  category: string
  amount: number
  cost_date: string
}

type CampaignRow = {
  id: number
  name: string
  active: boolean
  budget: number | null
}

async function getMarketingData() {
  const supabase = createAdminClient()
  const thirtyDaysAgo = subDays(new Date(), 30).toISOString().split('T')[0]

  const [costs, campaigns] = await Promise.all([
    supabase
      .from('marketing_costs')
      .select('*')
      .gte('cost_date', thirtyDaysAgo)
      .order('cost_date', { ascending: false }),
    supabase.from('campaigns').select('*').eq('active', true).limit(5),
  ])

  if (costs.error) {
    console.error('Erro ao listar custos de marketing:', costs.error.message)
  }

  if (campaigns.error) {
    console.error('Erro ao listar campanhas:', campaigns.error.message)
  }

  const costData = (costs.data ?? []) as MarketingCostRow[]
  const campaignData = (campaigns.data ?? []) as CampaignRow[]

  const total = costData.reduce((s, c) => s + Number(c.amount ?? 0), 0)

  const byCategory = costData.reduce((acc, c) => {
    acc[c.category] = (acc[c.category] ?? 0) + Number(c.amount ?? 0)
    return acc
  }, {} as Record<string, number>)

  return {
    costs: costData,
    campaigns: campaignData,
    total,
    byCategory,
  }
}

export default async function MarketingPage() {
  const { costs, campaigns, total, byCategory } = await getMarketingData()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Marketing</h1>
          <p className="text-sm text-muted-foreground">Últimos 30 dias</p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link href="/marketing/campanhas">
            <Button variant="outline">Campanhas</Button>
          </Link>

          <Link href="/marketing/custos">
            <Button variant="outline">Ver Custos</Button>
          </Link>

          <Link href="/marketing/custos/novo">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Lançar Custo
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <StatCard
          title="Custo Total"
          value={formatCurrency(total)}
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <StatCard
          title="Campanhas Ativas"
          value={String(campaigns.length)}
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <StatCard
          title="Categorias com Custo"
          value={String(Object.keys(byCategory).length)}
          icon={<TrendingUp className="h-4 w-4" />}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Custos Recentes</h2>
          </CardHeader>

          <div className="overflow-x-auto">
            {costs.length === 0 ? (
              <div className="px-6 pb-6 text-sm text-muted-foreground">
                Nenhum custo registrado
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead>Categoria</TableHead>
                    <TableHead>Valor</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {costs.slice(0, 8).map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>{formatDate(c.cost_date)}</TableCell>
                      <TableCell>
                        {CATEGORY_LABELS[c.category] ?? c.category}
                      </TableCell>
                      <TableCell>{formatCurrency(c.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Por Categoria</h2>
          </CardHeader>

          <div className="space-y-3 px-6 pb-6">
            {(Object.entries(byCategory) as [string, number][])
              .sort(([, a], [, b]) => b - a)
              .map(([cat, val]) => (
                <div
                  key={cat}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <span className="text-sm font-medium">
                    {CATEGORY_LABELS[cat] ?? cat}
                  </span>
                  <Badge variant="secondary">{formatCurrency(val)}</Badge>
                </div>
              ))}

            {Object.keys(byCategory).length === 0 && (
              <div className="text-sm text-muted-foreground">Sem dados</div>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}