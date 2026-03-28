import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'

interface StockAlert {
  product_id: number
  product_name: string
  current_qty: number
  stock_value_at_price: number
}

export function StockAlertsWidget({ alerts }: { alerts: StockAlert[] }) {
  return (
    <div className="space-y-3">
      {alerts.map((alert) => (
        <Link
          key={alert.product_id}
          href={`/produtos/${alert.product_id}`}
          className="flex items-center justify-between rounded-xl border border-border p-4 transition hover:bg-bg-hover"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-warning/10 text-warning">
              <AlertTriangle className="h-4 w-4" />
            </div>

            <div>
              <div className="font-medium">{alert.product_name}</div>
              <div className="text-sm text-muted-foreground">
                {alert.current_qty === 0 ? 'Esgotado' : `${alert.current_qty} un`}
              </div>
            </div>
          </div>
        </Link>
      ))}
    </div>
  )
}
