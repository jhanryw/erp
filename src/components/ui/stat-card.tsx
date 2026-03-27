import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

interface StatCardProps {
  title: string
  value: string | number
  subtitle?: string
  trend?: number | { value: number; label?: string }
  icon?: ReactNode
  className?: string
  valueClassName?: string
}

export function StatCard({
  title,
  value,
  subtitle,
  trend,
  icon,
  className,
  valueClassName,
}: StatCardProps) {
  const normalizedTrend =
    typeof trend === 'number' ? { value: trend } : trend

  const trendPositive = normalizedTrend && normalizedTrend.value > 0
  const trendNegative = normalizedTrend && normalizedTrend.value < 0

  return (
    <div className={cn('rounded-2xl border border-border bg-bg-card p-5', className)}>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{title}</span>
        {icon && (
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-bg-overlay text-text-secondary">
            {icon}
          </div>
        )}
      </div>

      <div className={cn('text-2xl font-semibold', valueClassName)}>{value}</div>

      {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}

      {normalizedTrend && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          {trendPositive && <TrendingUp className="h-3.5 w-3.5 text-success" />}
          {trendNegative && <TrendingDown className="h-3.5 w-3.5 text-error" />}
          {!trendPositive && !trendNegative && (
            <Minus className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span>
            {normalizedTrend.value > 0 ? '+' : ''}
            {normalizedTrend.value.toFixed(1)}%
          </span>
          {normalizedTrend.label && <span>{normalizedTrend.label}</span>}
        </div>
      )}
    </div>
  )
}