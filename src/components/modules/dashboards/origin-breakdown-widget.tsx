import type { OriginStat } from '@/services/dashboard'
import { ORIGIN_COLORS } from '@/lib/constants/origins'
import { formatCurrency } from '@/lib/utils/currency'

interface Props {
  origins: OriginStat[]
}

export function OriginBreakdownWidget({ origins }: Props) {
  if (origins.length === 0) {
    return (
      <p className="text-sm text-text-muted py-4 text-center">
        Nenhuma venda com origem registrada no período.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {origins.map((o) => {
        const color = ORIGIN_COLORS[o.origin] ?? '#6b7280'
        return (
          <div key={o.origin} className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: color }}
                />
                <span className="text-sm font-medium text-text-primary truncate">{o.label}</span>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0 text-right">
                <span className="text-xs text-text-muted">{o.orders} venda{o.orders !== 1 ? 's' : ''}</span>
                <span className="text-sm font-semibold text-text-primary tabular-nums">
                  {formatCurrency(o.revenue)}
                </span>
              </div>
            </div>

            {/* Barra de progresso */}
            <div className="w-full h-1.5 rounded-full bg-bg-subtle overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${Math.min(o.pct, 100)}%`, backgroundColor: color }}
              />
            </div>

            <p className="text-xs text-text-muted text-right">{o.pct.toFixed(1)}% do total</p>
          </div>
        )
      })}
    </div>
  )
}
