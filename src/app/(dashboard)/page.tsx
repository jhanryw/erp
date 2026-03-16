import { createClient } from '@/lib/supabase/server'
import { getDashboardData } from '@/services/dashboard'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { DailySalesChart } from '@/components/modules/dashboards/daily-sales-chart'
import { TopProductsWidget } from '@/components/modules/dashboards/top-products-widget'
import { StockAlertsWidget } from '@/components/modules/dashboards/stock-alerts-widget'
import { formatCurrency } from '@/lib/utils/currency'
import { ShoppingCart, TrendingUp, Users, Package } from 'lucide-react'
import type { UserRole } from '@/types/database.types'

export default async function DashboardPage() {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  let role: UserRole = 'seller'
  if (user) {
    const { data: profile } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single() as unknown as { data: { role: string } | null, error: any }
    role = (profile?.role ?? 'seller') as UserRole
  }

  const data = await getDashboardData(role)

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
        {/* Margem visível apenas para admin */}
        {data.showFinancials && data.month.grossMarginPct !== null ? (
          <StatCard
            title="Margem Bruta"
            value={`${data.month.grossMarginPct.toFixed(1)}%`}
            subtitle="Média do mês"
            icon={<Package className="w-4 h-4" />}
          />
        ) : (
          <StatCard
            title="Produtos Vendidos"
            value={String(data.topProducts.reduce((s, p) => s + p.total_units_sold, 0))}
            subtitle="Últimos 30 dias"
            icon={<Package className="w-4 h-4" />}
          />
        )}
      </div>

      {/* Gráfico + Top Produtos */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold text-text-primary">
                Faturamento — Últimos 30 dias
              </h3>
            </CardHeader>
            <CardContent className="pt-2 pb-4">
              <DailySalesChart data={data.dailySeries} />
            </CardContent>
          </Card>
        </div>

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
            <h3 className="text-sm font-semibold text-text-primary">Alertas de Estoque</h3>
            <span className="text-xs text-error font-medium">
              {data.stockAlerts.length} produto
              {data.stockAlerts.length > 1 ? 's' : ''} com estoque baixo
            </span>
          </CardHeader>
          <StockAlertsWidget alerts={data.stockAlerts} />
        </Card>
      )}
    </div>
  )
}
