'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Button } from './button'
import { cn } from '@/lib/utils/cn'

interface EmptyStateProps {
  icon: ReactNode
  title: string
  description?: string
  action?: { label: string; href: string }
  className?: string
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex min-h-[240px] flex-col items-center justify-center rounded-2xl border border-border bg-bg-card p-8 text-center',
        className
      )}
    >
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-bg-overlay text-text-secondary">
        {icon}
      </div>

      <h3 className="mb-2 text-lg font-semibold">{title}</h3>

      {description && (
        <p className="mb-6 max-w-md text-sm text-muted-foreground">
          {description}
        </p>
      )}

      {action && (
        <Link href={action.href}>
          <Button>{action.label}</Button>
        </Link>
      )}
    </div>
  )
}