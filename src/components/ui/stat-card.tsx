import { cn } from '@/lib/utils/cn'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

interface StatCardProps {
  title: string
  value: string | number
  subtitle?: string
  trend?: {
    value: number // percentual
    label?: string
  }
  icon?: React.ReactNode
  className?: string
  valueClassName?: string
}

export function StatCard({ title, value, subtitle, trend, icon, className, valueClassName }: StatCardProps) {
  const trendPositive = trend && trend.value > 0
  const trendNegative = trend && trend.value < 0

  return (
    <div className={cn('card p-5 flex flex-col gap-3', className)}>
      <div className="flex items-start justify-between">
        <p className="text-sm text-text-secondary font-medium">{title}</p>
        {icon && (
          <div className="p-2 rounded-lg bg-brand/10 text-brand">
            {icon}
          </div>
        )}
      </div>

      <div>
        <p className={cn('stat-value', valueClassName)}>{value}</p>
        {subtitle && <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>}
      </div>

      {trend && (
        <div className="flex items-center gap-1.5">
          {trendPositive && <TrendingUp className="w-3.5 h-3.5 text-success" />}
          {trendNegative && <TrendingDown className="w-3.5 h-3.5 text-error" />}
          {!trendPositive && !trendNegative && <Minus className="w-3.5 h-3.5 text-text-muted" />}
          <span
            className={cn(
              'text-xs font-medium',
              trendPositive ? 'text-success' : trendNegative ? 'text-error' : 'text-text-muted'
            )}
          >
            {trend.value > 0 ? '+' : ''}
            {trend.value.toFixed(1)}%
          </span>
          {trend.label && <span className="text-xs text-text-muted">{trend.label}</span>}
        </div>
      )}
    </div>
  )
}
