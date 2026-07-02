import type { SellerStat } from '@/services/dashboard'
import { formatCurrency } from '@/lib/utils/currency'

// Paleta fixa — mesma lógica visual do ORIGIN_COLORS
const SELLER_COLORS = [
  '#6366f1', // índigo
  '#f59e0b', // âmbar
  '#10b981', // esmeralda
  '#ef4444', // vermelho
  '#8b5cf6', // violeta
  '#06b6d4', // ciano
]

interface Props {
  sellers: SellerStat[]
}

export function SellerBreakdownWidget({ sellers }: Props) {
  if (sellers.length === 0) {
    return (
      <p className="text-sm text-text-muted py-4 text-center">
        Nenhuma venda com vendedor responsável registrado no período.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {sellers.map((s, idx) => {
        const color = SELLER_COLORS[idx % SELLER_COLORS.length]
        return (
          <div key={s.sellerId} className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: color }}
                />
                <span className="text-sm font-medium text-text-primary truncate">
                  {s.sellerName}
                </span>
              </div>
              <span className="text-sm font-semibold text-text-primary tabular-nums flex-shrink-0">
                {formatCurrency(s.revenue)}
              </span>
            </div>

            <div className="w-full h-1.5 rounded-full bg-bg-subtle overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${Math.min(s.pct, 100)}%`, backgroundColor: color }}
              />
            </div>

            <p className="text-xs text-text-muted text-right">{s.pct.toFixed(1)}% do total</p>
          </div>
        )
      })}
    </div>
  )
}
