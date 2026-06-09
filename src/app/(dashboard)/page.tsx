import { ShoppingCart, TrendingUp, Users, Package, BarChart2 } from 'lucide-react'
import Link from 'next/link'

import { createClient } from '@/lib/supabase/server'
import { getUserProfile } from '@/lib/auth/getProfile'
import { getDashboardData } from '@/services/dashboard'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { DailySalesChart } from '@/components/modules/dashboards/daily-sales-chart'
import { TopProductsWidget } from '@/components/modules/dashboards/top-products-widget'
import { StockAlertsWidget } from '@/components/modules/dashboards/stock-alerts-widget'
import { RefreshViewsButton } from '@/components/modules/dashboards/refresh-views-button'
import { DateRangePicker } from '@/components/modules/dashboards/date-range-picker'
import { SalesByOriginChart } from '@/components/modules/dashboards/sales-by-origin-chart'
import { OriginBreakdownWidget } from '@/components/modules/dashboards/origin-breakdown-widget'
import { formatCurrency } from '@/lib/utils/currency'
import { hasMinRole } from '@/types/roles'
import { brazilDate, brazilSubDays } from '@/lib/utils/date'
import type { RangePreset } from '@/components/modules/dashboards/date-range-picker'

export const dynamic = 'force-dynamic'

type SearchParams = Promise<{
  range?: string
  from?: string
  to?: string
}>

function resolveDateRange(range?: string, from?: string, to?: string): {
  dateFrom: string
  dateTo: string
  activeRange: RangePreset | 'custom'
  rangeLabel: string
} {
  const today = brazilDate()

  if (range === 'today') {
    return { dateFrom: today, dateTo: today, activeRange: 'today', rangeLabel: 'Hoje' }
  }
  if (range === 'yesterday') {
    const y = brazilSubDays(1)
    return { dateFrom: y, dateTo: y, activeRange: 'yesterday', rangeLabel: 'Ontem' }
  }
  if (range === '7d') {
    return { dateFrom: brazilSubDays(6), dateTo: today, activeRange: '7d', rangeLabel: 'Últimos 7 dias' }
  }
  if (range === '90d') {
    return { dateFrom: brazilSubDays(89), dateTo: today, activeRange: '90d', rangeLabel: 'Últimos 90 dias' }
  }
  if (range === 'year') {
    const year = today.substring(0, 4)
    return { dateFrom: `${year}-01-01`, dateTo: today, activeRange: 'year', rangeLabel: `Ano ${year}` }
  }
  if (range === 'custom' && from && to && from <= to) {
    const [fy, fm, fd] = from.split('-')
    const [ty, tm, td] = to.split('-')
    return {
      dateFrom: from,
      dateTo: to,
      activeRange: 'custom',
      rangeLabel: `${fd}/${fm}/${fy} – ${td}/${tm}/${ty}`,
    }
  }

  // Default: últimos 30 dias
  return { dateFrom: brazilSubDays(29), dateTo: today, activeRange: '30d', rangeLabel: 'Últimos 30 dias' }
}

export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const { range, from, to } = await searchParams

  const { dateFrom, dateTo, activeRange, rangeLabel } = resolveDateRange(range, from, to)

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const profile = user ? await getUserProfile(user.id, user.email) : null
  const role = profile?.role ?? 'usuario'

  const data = await getDashboardData(role, dateFrom, dateTo)

  const todayAvgTicket =
    data.today.orders > 0 ? data.today.revenue / data.today.orders : 0

  // Rótulo dinâmico do período para os cards
  const periodLabel = rangeLabel

  return (
    <div className="space-y-6">
      {/* ── Cabeçalho ──────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Visão geral dos principais indicadores do ERP
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasMinRole(role, 'gerente') && <RefreshViewsButton />}
          <Link href="/dashboard">
            <Button variant="outline" size="sm">
              <BarChart2 className="mr-2 h-4 w-4" />
              <span className="hidden sm:inline">Dashboard Executivo</span>
              <span className="sm:hidden">Executivo</span>
            </Button>
          </Link>
        </div>
      </div>

      {/* ── Seletor de período ──────────────────────────────────────── */}
      <DateRangePicker
        activeRange={activeRange}
        dateFrom={activeRange === 'custom' ? dateFrom : undefined}
        dateTo={activeRange === 'custom' ? dateTo : undefined}
      />

      {/* ── KPI Cards — Hoje ───────────────────────────────────────── */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Faturamento Hoje"
          value={formatCurrency(data.today.revenue)}
          subtitle={`${data.today.orders} pedido${data.today.orders !== 1 ? 's' : ''}`}
          icon={<TrendingUp className="h-4 w-4" />}
        />

        <StatCard
          title="Pedidos Hoje"
          value={String(data.today.orders)}
          subtitle={`Ticket médio: ${formatCurrency(todayAvgTicket)}`}
          icon={<ShoppingCart className="h-4 w-4" />}
        />

        <StatCard
          title={`Faturamento — ${periodLabel}`}
          value={formatCurrency(data.period.revenue)}
          subtitle={`${data.period.orders} pedido${data.period.orders !== 1 ? 's' : ''}`}
          icon={<Users className="h-4 w-4" />}
        />

        {data.showFinancials && data.period.grossMarginPct !== null ? (
          <StatCard
            title="Margem Bruta"
            value={`${data.period.grossMarginPct.toFixed(1)}%`}
            subtitle={periodLabel}
            icon={<Package className="h-4 w-4" />}
          />
        ) : (
          <StatCard
            title="Ticket Médio"
            value={formatCurrency(data.period.avgTicket)}
            subtitle={periodLabel}
            icon={<Package className="h-4 w-4" />}
          />
        )}
      </div>

      {/* ── Gráfico de faturamento diário ──────────────────────────── */}
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Faturamento — {periodLabel}</h2>
        </CardHeader>
        <CardContent>
          <DailySalesChart data={data.dailySeries} />
        </CardContent>
      </Card>

      {/* ── Origem de venda ────────────────────────────────────────── */}
      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <h2 className="text-lg font-semibold">Vendas por Origem — {periodLabel}</h2>
            <p className="text-sm text-muted-foreground">
              Faturamento diário empilhado por canal de captação
            </p>
          </CardHeader>
          <CardContent>
            <SalesByOriginChart
              dailyOriginSeries={data.dailyOriginSeries}
              originBreakdown={data.originBreakdown}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Breakdown por Canal</h2>
            <p className="text-sm text-muted-foreground">{periodLabel}</p>
          </CardHeader>
          <CardContent>
            <OriginBreakdownWidget origins={data.originBreakdown} />
          </CardContent>
        </Card>
      </div>

      {/* ── Top Produtos + Alertas ──────────────────────────────────── */}
      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <h2 className="text-lg font-semibold">Top Produtos</h2>
          </CardHeader>
          <CardContent>
            <TopProductsWidget products={data.topProducts} />
          </CardContent>
        </Card>

        {data.stockAlerts.length > 0 && (
          <Card>
            <CardHeader>
              <h2 className="text-lg font-semibold">Alertas de Estoque</h2>
              <p className="text-sm text-muted-foreground">
                {data.stockAlerts.length} produto
                {data.stockAlerts.length > 1 ? 's' : ''} com estoque baixo
              </p>
            </CardHeader>
            <CardContent>
              <StockAlertsWidget alerts={data.stockAlerts} />
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
