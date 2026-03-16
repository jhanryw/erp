import { createClient } from '@/lib/supabase/server'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { DailySalesChart } from '@/components/modules/dashboards/daily-sales-chart'
import { TopProductsWidget } from '@/components/modules/dashboards/top-products-widget'
import { StockAlertsWidget } from '@/components/modules/dashboards/stock-alerts-widget'
import { formatCurrency, formatNumber } from '@/lib/utils/currency'
import { ShoppingCart, TrendingUp, Users, Package } from 'lucide-react'
import { formatDate } from '@/lib/utils/date'
import { subDays } from 'date-fns'

async function getDashboardData() {
  const supabase = createClient()
  const today = formatDate(new Date(), 'yyyy-MM-dd')
  const thirtyDaysAgo = formatDate(subDays(new Date(), 30), 'yyyy-MM-dd')

  const [todaySales, monthlySales, dailySeries, topProducts, stockAlerts] =
    await Promise.all([
      // Vendas de hoje
      supabase
        .from('mv_daily_sales_summary')
        .select('*')
        .eq('sale_date', today)
        .single(),

      // Vendas dos últimos 30 dias
      supabase
        .from('mv_daily_sales_summary')
        .select('*')
        .gte('sale_date', thirtyDaysAgo),

      // Série temporal para gráfico
      supabase
        .from('mv_daily_sales_summary')
        .select('sale_date, gross_revenue, total_orders')
        .gte('sale_date', thirtyDaysAgo)
        .order('sale_date', { ascending: true }),

      // Top 5 produtos
      supabase
        .from('mv_product_performance')
        .select('product_id, product_name, total_revenue, total_units_sold, realized_margin_pct')
        .order('total_revenue', { ascending: false })
        .limit(5),

      // Alertas de estoque
      supabase
        .from('mv_stock_status')
        .select('product_id, product_name, current_qty, stock_value_at_price')
        .lte('current_qty', 3)
        .order('current_qty', { ascending: true })
        .limit(5),
    ])

  const todayData = todaySales.data
  const monthData = monthlySales.data ?? []

  const monthRevenue = monthData.reduce((s, r) => s + (r.gross_revenue ?? 0), 0)
  const monthOrders = monthData.reduce((s, r) => s + (r.total_orders ?? 0), 0)
  const avgTicket = monthOrders > 0 ? monthRevenue / monthOrders : 0
  const avgMargin = monthData.length > 0
    ? monthData.reduce((s, r) => s + (r.gross_profit ?? 0), 0) / monthRevenue * 100
    : 0

  return {
    today: {
      revenue: todayData?.gross_revenue ?? 0,
      orders: todayData?.total_orders ?? 0,
    },
    month: {
      revenue: monthRevenue,
      orders: monthOrders,
      avgTicket,
      avgMargin,
    },
    dailySeries: dailySeries.data ?? [],
    topProducts: topProducts.data ?? [],
    stockAlerts: stockAlerts.data ?? [],
  }
}

export default async function DashboardPage() {
  const data = await getDashboardData()

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Faturamento Hoje"
          value={formatCurrency(data.today.revenue)}
          subtitle={`${data.today.orders} ${data.today.orders === 1 ? 'venda' : 'vendas'}`}
          icon={<TrendingUp className="w-4 h-4" />}
        />
        <StatCard
          title="Faturamento Mensal"
          value={formatCurrency(data.month.revenue)}
          subtitle={`${data.month.orders} vendas no mês`}
          icon={<ShoppingCart className="w-4 h-4" />}
        />
        <StatCard
          title="Ticket Médio"
          value={formatCurrency(data.month.avgTicket)}
          subtitle="Últimos 30 dias"
          icon={<Users className="w-4 h-4" />}
        />
        <StatCard
          title="Margem Bruta"
          value={`${data.month.avgMargin.toFixed(1)}%`}
          subtitle="Média do mês"
          icon={<Package className="w-4 h-4" />}
        />
      </div>

      {/* Gráfico + Widgets */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Gráfico de faturamento */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold text-text-primary">Faturamento — Últimos 30 dias</h3>
            </CardHeader>
            <CardContent className="pt-2 pb-4">
              <DailySalesChart data={data.dailySeries} />
            </CardContent>
          </Card>
        </div>

        {/* Top produtos */}
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Top Produtos</h3>
          </CardHeader>
          <TopProductsWidget products={data.topProducts} />
        </Card>
      </div>

      {/* Alertas de estoque */}
      {data.stockAlerts.length > 0 && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">
              Alertas de Estoque
            </h3>
            <span className="text-xs text-error font-medium">
              {data.stockAlerts.length} produto{data.stockAlerts.length > 1 ? 's' : ''} com estoque baixo
            </span>
          </CardHeader>
          <StockAlertsWidget alerts={data.stockAlerts} />
        </Card>
      )}
    </div>
  )
}
