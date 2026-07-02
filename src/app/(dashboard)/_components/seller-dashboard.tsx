import { TrendingUp, ShoppingCart, Users, Tag, Package } from 'lucide-react'
import { StatCard } from '@/components/ui/stat-card'
import { formatCurrency } from '@/lib/utils/currency'
import type { SellerDashboardData } from '@/services/sellerDashboard'

interface Props {
  data: SellerDashboardData
}

export function SellerDashboard({ data }: Props) {
  const { today, topProducts } = data
  const topProduct = topProducts[0] ?? null

  return (
    <div className="space-y-6">
      {/* Cabeçalho */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Meu Painel</h1>
        <p className="text-sm text-text-muted">
          {data.sellerName} · resultados de hoje
        </p>
      </div>

      {/* KPIs de hoje */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Faturamento Bruto"
          value={formatCurrency(today.revenue)}
          subtitle="Hoje"
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <StatCard
          title="Vendas Realizadas"
          value={String(today.orders)}
          subtitle={today.orders === 1 ? '1 pedido hoje' : `${today.orders} pedidos hoje`}
          icon={<ShoppingCart className="h-4 w-4" />}
        />
        <StatCard
          title="Ticket Médio"
          value={formatCurrency(today.avgTicket)}
          subtitle="Média por pedido"
          icon={<ShoppingCart className="h-4 w-4" />}
        />
        <StatCard
          title="Clientes Atendidos"
          value={String(today.customers)}
          subtitle="Clientes únicos hoje"
          icon={<Users className="h-4 w-4" />}
        />
      </div>

      {/* Linha 2: descontos + badges de pagamento/canal + produto mais vendido */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          title="Descontos Concedidos"
          value={formatCurrency(today.discounts)}
          subtitle="Total de descontos hoje"
          icon={<Tag className="h-4 w-4" />}
        />

        {/* Forma de pagamento e canal */}
        <div className="rounded-2xl border border-border bg-bg-card p-5 space-y-3">
          <p className="text-sm font-medium text-text-secondary">Destaques de Hoje</p>
          {today.topPaymentMethod ? (
            <div className="flex items-center justify-between text-sm">
              <span className="text-text-muted">Pagamento mais usado</span>
              <span className="font-semibold text-text-primary">{today.topPaymentMethod}</span>
            </div>
          ) : null}
          {today.topOrigin ? (
            <div className="flex items-center justify-between text-sm">
              <span className="text-text-muted">Canal mais usado</span>
              <span className="font-semibold text-text-primary">{today.topOrigin}</span>
            </div>
          ) : null}
          {!today.topPaymentMethod && !today.topOrigin && (
            <p className="text-sm text-text-muted">Nenhum dado ainda.</p>
          )}
        </div>

        {/* Produto mais vendido hoje */}
        <div className="rounded-2xl border border-border bg-bg-card p-5 space-y-2">
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 text-text-muted" />
            <p className="text-sm font-medium text-text-secondary">Produto Mais Vendido</p>
          </div>
          {topProduct ? (
            <>
              <p className="font-semibold text-text-primary truncate">{topProduct.product_name}</p>
              <p className="text-sm text-text-muted">{topProduct.total_units} un · {formatCurrency(topProduct.total_revenue)}</p>
            </>
          ) : (
            <p className="text-sm text-text-muted">Nenhuma venda registrada hoje.</p>
          )}
        </div>
      </div>

      {today.orders === 0 && (
        <div className="rounded-xl border border-border bg-bg-elevated px-4 py-4 text-sm text-text-muted text-center">
          Nenhuma venda registrada hoje.
        </div>
      )}
    </div>
  )
}
