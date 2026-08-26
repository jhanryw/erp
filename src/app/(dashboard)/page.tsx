import { ShoppingCart, TrendingUp, Users, Package, BarChart2 } from 'lucide-react'
import Link from 'next/link'

import { createClient } from '@/lib/supabase/server'
import { getUserProfile } from '@/lib/auth/getProfile'
import { getDashboardData } from '@/services/dashboard'
import { getRevenueTrend } from '@/services/revenueTrend'
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
import { SellerBreakdownWidget } from '@/components/modules/dashboards/seller-breakdown-widget'
import { ModalityBreakdownWidget } from '@/components/modules/dashboards/modality-breakdown-widget'
import { formatCurrency } from '@/lib/utils/currency'
import { hasMinRole } from '@/types/roles'
import { resolveDateRange } from '@/lib/utils/dateRange'

export const dynamic = 'force-dynamic'

type SearchParams = Promise<{
  range?: string
  from?: string
  to?: string
}>

export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const { range, from, to } = await searchParams

  const { dateFrom, dateTo, activeRange, rangeLabel } = resolveDateRange(range, from, to)

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const profile = user ? await getUserProfile(user.id, user.email) : null
  const role = profile?.role ?? 'usuario'

  if (!profile?.company_id) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[40vh] gap-4 text-center">
        <h2 className="text-lg font-semibold">Sessão inválida</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          Não foi possível identificar sua empresa. Faça logout e entre novamente.
        </p>
      </div>
    )
  }

  // Fase 2 (ajuste final) — usuario = admin fora dos 9 módulos bloqueados.
  // Dashboard não está bloqueado: usuario vê o mesmo dashboard que
  // gerente/admin — mesmos indicadores, mesma margem, sem versão "reduzida
  // de vendedor". company_id vem sempre da sessão (nunca do cliente);
  // getDashboardData() usa esse company_id para isolar tenant em toda
  // consulta (inclusive nas materialized views, que ganharam a coluna em
  // 20260812_add_company_id_dashboard_mvs.sql).
  const data = await getDashboardData(profile.company_id, dateFrom, dateTo)

  // Série de tendência (MM7/MM30) é independente do range da página: busca
  // o histórico completo da empresa e o próprio gráfico recorta a
  // exibição (7D/30D/90D/6M/1A/Tudo) sem recalcular as médias móveis.
  const revenueTrend = profile?.company_id ? await getRevenueTrend(profile.company_id) : []

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

        {data.period.grossMarginPct !== null ? (
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

      {/* ── Composição Varejo × Atacado — discreta, sob o faturamento do
          período. Analytics Varejo/Atacado: "não transforme todo o
          dashboard numa tela de atacado" — uma linha fina, sem card
          próprio, com link pro relatório completo pra quem quiser mais. */}
      <div className="rounded-2xl border border-border bg-bg-card px-5 py-3 -mt-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Composição do faturamento — {periodLabel}</span>
          <Link href="/relatorios/varejo-atacado" className="text-xs text-accent hover:underline">
            Ver detalhes →
          </Link>
        </div>
        <ModalityBreakdownWidget modality={data.modalityBreakdown} />
      </div>

      {/* ── Gráfico de tendência de faturamento (MM7/MM30) ───────────
          Período próprio (7D/30D/90D/6M/1A/Tudo), independente do
          seletor de período da página acima — este gráfico sempre
          trabalha sobre o histórico completo para que as médias móveis
          nunca sejam distorcidas por um recorte curto. */}
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Tendência de Faturamento</h2>
          <p className="text-sm text-muted-foreground">
            Faturamento diário com médias móveis de 7 e 30 dias
          </p>
        </CardHeader>
        <CardContent>
          <DailySalesChart data={revenueTrend} />
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

        {/* Coluna direita: dois breakdowns empilhados */}
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <h2 className="text-lg font-semibold">Breakdown por Canal</h2>
              <p className="text-sm text-muted-foreground">{periodLabel}</p>
            </CardHeader>
            <CardContent>
              <OriginBreakdownWidget origins={data.originBreakdown} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <h2 className="text-lg font-semibold">Faturamento por Vendedor</h2>
              <p className="text-sm text-muted-foreground">
                Receita líquida por vendedor no período selecionado.
              </p>
            </CardHeader>
            <CardContent>
              <SellerBreakdownWidget sellers={data.sellerBreakdown} />
            </CardContent>
          </Card>
        </div>
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
