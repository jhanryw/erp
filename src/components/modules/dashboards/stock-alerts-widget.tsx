import { AlertTriangle } from 'lucide-react'
import Link from 'next/link'

interface StockAlert {
  product_id: number
  product_name: string
  current_qty: number
  stock_value_at_price: number
}

export function StockAlertsWidget({ alerts }: { alerts: StockAlert[] }) {
  return (
    <div className="divide-y divide-border/50">
      {alerts.map((alert) => (
        <Link
          key={alert.product_id}
          href={`/produtos/${alert.product_id}`}
          className="flex items-center gap-3 px-5 py-3 hover:bg-white/[0.03] transition-colors"
        >
          <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0" />
          <p className="flex-1 text-sm text-text-primary truncate">{alert.product_name}</p>
          <span
            className={`text-xs font-semibold px-2 py-0.5 rounded-md ${
              alert.current_qty === 0
                ? 'bg-error/10 text-error'
                : 'bg-warning/10 text-warning'
            }`}
          >
            {alert.current_qty === 0 ? 'Esgotado' : `${alert.current_qty} un`}
          </span>
        </Link>
      ))}
    </div>
  )
}
