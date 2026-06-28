import { TrendingUp, ShoppingCart, Users, Tag, Package, Target } from 'lucide-react'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { DailySalesChart } from '@/components/modules/dashboards/daily-sales-chart'
import { DateRangePicker } from '@/components/modules/dashboards/date-range-picker'
import { formatCurrency, formatPercent } from '@/lib/utils/currency'
import type { SellerDashboardData } from '@/services/sellerDashboard'
import type { RangePreset } from '@/components/modules/dashboards/date-range-picker'

interface Props {
  data:        SellerDashboardData
  activeRange: RangePreset | 'custom'
  rangeLabel:  string
  dateFrom:    string
  dateTo:      string
}

export function SellerDashboard({ data, activeRange, rangeLabel, dateFrom, dateTo }: Props) {
  const { today, period, dailySeries, topProducts, monthlyGoal } = data

  return (
    <div className="space-y-6">
      {/* ── Cabeçalho ──────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Meu Painel</h1>
        <p className="text-sm text-muted-foreground">
          {data.sellerName} · resultados pessoais
        </p>
      </div>

      <DateRangePicker
        activeRange={activeRange}
        dateFrom={activeRange === 'custom' ? dateFrom : undefined}
        dateTo={activeRange === 'custom' ? dateTo : undefined}
      />

      {/* ── KPIs de hoje ──────────────────────────────────────────── */}
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">Hoje</p>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard
            title="Faturamento"
            value={formatCurrency(today.revenue)}
            subtitle={`${today.orders} pedido${today.orders !== 1 ? 's' : ''}`}
            icon={<TrendingUp className="h-4 w-4" />}
          />
          <StatCard
            title="Ticket Médio"
            value={formatCurrency(today.avgTicket)}
            subtitle="Média por pedido hoje"
            icon={<ShoppingCart className="h-4 w-4" />}
          />
          <StatCard
            title="Descontos Concedidos"
            value={formatCurrency(today.discounts)}
            subtitle="Total de descontos hoje"
            icon={<Tag className="h-4 w-4" />}
          />
          <StatCard
            title="Clientes Atendidos"
            value={String(today.customers)}
            subtitle="Clientes únicos hoje"
            icon={<Users className="h-4 w-4" />}
          />
        </div>

        {/* Top pagamento e canal hoje */}
        {(today.topPaymentMethod || today.topOrigin) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {today.topPaymentMethod && (
              <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-bg-overlay text-text-secondary border border-border">
                <span className="text-text-muted">Pagamento mais usado:</span>
                <span className="font-medium">{today.topPaymentMethod}</span>
              </span>
            )}
            {today.topOrigin && (
              <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-bg-overlay text-text-secondary border border-border">
                <span className="text-text-muted">Canal mais usado:</span>
                <span className="font-medium">{today.topOrigin}</span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── Meta do mês ───────────────────────────────────────────── */}
      {monthlyGoal && (
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Target className="h-4 w-4 text-brand" />
                <span className="text-sm font-semibold">Meta do Mês</span>
              </div>
              <span className="text-sm font-semibold text-brand">
                {monthlyGoal.pct.toFixed(1)}%
              </span>
            </div>
            <div className="h-2.5 rounded-full bg-bg-overlay overflow-hidden mb-2">
              <div
                className="h-full rounded-full bg-brand transition-all"
                style={{ width: `${Math.min(100, monthlyGoal.pct)}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{formatCurrency(monthlyGoal.current)} realizado</span>
              <span>meta: {formatCurrency(monthlyGoal.target)}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── KPIs do período ────────────────────────────────────────── */}
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">{rangeLabel}</p>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard
            title="Faturamento"
            value={formatCurrency(period.revenue)}
            subtitle={`${period.orders} pedido${period.orders !== 1 ? 's' : ''}`}
            icon={<TrendingUp className="h-4 w-4" />}
          />
          <StatCard
            title="Ticket Médio"
            value={formatCurrency(period.avgTicket)}
            subtitle={rangeLabel}
            icon={<ShoppingCart className="h-4 w-4" />}
          />
          <StatCard
            title="Descontos Concedidos"
            value={formatCurrency(period.discounts)}
            subtitle={rangeLabel}
            icon={<Tag className="h-4 w-4" />}
          />
          <StatCard
            title="Clientes Atendidos"
            value={String(period.customers)}
            subtitle="Clientes únicos"
            icon={<Users className="h-4 w-4" />}
          />
        </div>
      </div>

      {/* ── Gráfico de faturamento diário ──────────────────────────── */}
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Faturamento — {rangeLabel}</h2>
        </CardHeader>
        <CardContent>
          <DailySalesChart data={dailySeries} />
        </CardContent>
      </Card>

      {/* ── Produtos mais vendidos ─────────────────────────────────── */}
      {topProducts.length > 0 && (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">Produtos Mais Vendidos</h2>
            <p className="text-sm text-muted-foreground">{rangeLabel}</p>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {topProducts.map((p, i) => {
                const maxRev = topProducts[0]?.total_revenue ?? 1
                const pct = maxRev > 0 ? (p.total_revenue / maxRev) * 100 : 0
                return (
                  <div key={p.product_id} className="rounded-xl border border-border p-4">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-bg-overlay text-xs font-semibold text-text-secondary">
                          {i + 1}
                        </div>
                        <div>
                          <div className="font-medium">{p.product_name}</div>
                          <div className="text-xs text-muted-foreground">{p.total_units} un</div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-medium">{formatCurrency(p.total_revenue)}</div>
                      </div>
                    </div>
                    <div className="h-2 rounded-full bg-bg-overlay">
                      <div className="h-2 rounded-full bg-brand" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
