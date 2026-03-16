import { formatCurrency, formatPercent } from '@/lib/utils/currency'
import Link from 'next/link'

interface TopProduct {
  product_id: number
  product_name: string
  total_revenue: number
  total_units_sold: number
  realized_margin_pct: number | null
}

export function TopProductsWidget({ products }: { products: TopProduct[] }) {
  if (!products.length) {
    return (
      <div className="p-5 text-center text-sm text-text-muted">
        Sem vendas no período
      </div>
    )
  }

  const maxRevenue = Math.max(...products.map((p) => p.total_revenue))

  return (
    <div className="divide-y divide-border/50">
      {products.map((product, i) => {
        const pct = maxRevenue > 0 ? (product.total_revenue / maxRevenue) * 100 : 0
        return (
          <Link
            key={product.product_id}
            href={`/produtos/${product.product_id}`}
            className="flex items-center gap-3 px-5 py-3.5 hover:bg-white/[0.03] transition-colors"
          >
            <span className="text-xs font-bold text-text-muted w-5 text-center">
              {i + 1}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">
                {product.product_name}
              </p>
              <div className="flex items-center gap-2 mt-1">
                <div className="flex-1 h-1.5 bg-bg-overlay rounded-full overflow-hidden">
                  <div
                    className="h-full bg-brand rounded-full"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-[10px] text-text-muted whitespace-nowrap">
                  {product.total_units_sold} un
                </span>
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-sm font-semibold text-text-primary">
                {formatCurrency(product.total_revenue)}
              </p>
              <p className="text-xs text-text-muted">
                {product.realized_margin_pct != null ? formatPercent(product.realized_margin_pct) : '—'} mg
              </p>
            </div>
          </Link>
        )
      })}
    </div>
  )
}
