import { cn } from '@/lib/utils/cn'

interface SkeletonProps {
  className?: string
}

export function Skeleton({ className }: SkeletonProps) {
  return <div className={cn('skeleton rounded-lg', className)} />
}

export function SkeletonTable({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-0">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4 px-4 py-3.5 border-b border-border/50">
          {Array.from({ length: cols }).map((_, j) => (
            <Skeleton
              key={j}
              className={cn('h-4', j === 0 ? 'w-1/4' : j === cols - 1 ? 'w-16' : 'w-1/5')}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

export function SkeletonCards({ count = 4 }: { count?: number }) {
  return (
    <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-${count} gap-4`}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card p-5 space-y-3">
          <div className="flex items-start justify-between">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-8 rounded-lg" />
          </div>
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  )
}
