'use client'

import { cn } from '@/lib/utils/cn'
import type { LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { Button } from './button'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  action?: {
    label: string
    href: string
  }
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-16 px-6 text-center', className)}>
      <div className="w-12 h-12 rounded-2xl bg-bg-overlay flex items-center justify-center mb-4">
        <Icon className="w-6 h-6 text-text-muted" />
      </div>
      <h3 className="text-sm font-medium text-text-primary mb-1">{title}</h3>
      {description && (
        <p className="text-sm text-text-secondary max-w-sm">{description}</p>
      )}
      {action && (
        <Link href={action.href}>
          <Button className="mt-5" size="sm">
            {action.label}
          </Button>
        </Link>
      )}
    </div>
  )
}
