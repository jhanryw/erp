import Link from 'next/link'
import { formatCurrency, formatPercent } from '@/lib/utils/currency'

interface TopProduct {
  product_id: number
  product_name: string
  total_revenue: number
  total_units_sold: number
  realized_margin_pct: number | null
}

export function TopProductsWidget({ products }: { products: TopProduct[] }) {
  if (!products.length) {
    return <div className="text-sm text-muted-foreground">Sem vendas no período</div>
  }

  const maxRevenue = Math.max(...products.map((p) => p.total_revenue))

  return (
    <div className="space-y-4">
      {products.map((product, i) => {
        const pct = maxRevenue > 0 ? (product.total_revenue / maxRevenue) * 100 : 0

        return (
          <Link
            key={product.product_id}
            href={`/produtos/${product.product_id}`}
            className="block rounded-xl border border-border p-4 transition hover:bg-bg-hover"
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-bg-overlay text-xs font-semibold text-text-secondary">
                  {i + 1}
                </div>
                <div>
                  <div className="font-medium">{product.product_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {product.total_units_sold} un
                  </div>
                </div>
              </div>

              <div className="text-right">
                <div className="font-medium">{formatCurrency(product.total_revenue)}</div>
                <div className="text-xs text-muted-foreground">
                  {product.realized_margin_pct != null
                    ? `${formatPercent(product.realized_margin_pct)} mg`
                    : '—'}
                </div>
              </div>
            </div>

            <div className="h-2 rounded-full bg-bg-overlay">
              <div
                className="h-2 rounded-full bg-brand"
                style={{ width: `${pct}%` }}
              />
            </div>
          </Link>
        )
      })}
    </div>
  )
}
