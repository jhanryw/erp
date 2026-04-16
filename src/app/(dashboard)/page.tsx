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
import { formatCurrency } from '@/lib/utils/currency'
import { hasMinRole } from '@/types/roles'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  // O layout já verifica autenticação — aqui apenas lemos o role para o serviço
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const profile = user ? await getUserProfile(user.id, user.email) : null
  const role = profile?.role ?? 'usuario'

  const data = await getDashboardData(role)

  const todayAvgTicket =
    data.today.orders > 0 ? data.today.revenue / data.today.orders : 0

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
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
          title="Faturamento 30 dias"
          value={formatCurrency(data.month.revenue)}
          subtitle={`${data.month.orders} pedido${data.month.orders !== 1 ? 's' : ''}`}
          icon={<Users className="h-4 w-4" />}
        />

        {data.showFinancials && data.month.grossMarginPct !== null ? (
          <StatCard
            title="Margem Bruta"
            value={`${data.month.grossMarginPct.toFixed(1)}%`}
            subtitle="Últimos 30 dias"
            icon={<Package className="h-4 w-4" />}
          />
        ) : (
          <StatCard
            title="Ticket Médio"
            value={formatCurrency(data.month.avgTicket)}
            subtitle="Últimos 30 dias"
            icon={<Package className="h-4 w-4" />}
          />
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <h2 className="text-lg font-semibold">Faturamento — Últimos 30 dias</h2>
          </CardHeader>
          <CardContent>
            <DailySalesChart data={data.dailySeries} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Top Produtos</h2>
          </CardHeader>
          <CardContent>
            <TopProductsWidget products={data.topProducts} />
          </CardContent>
        </Card>
      </div>

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
  )
}
