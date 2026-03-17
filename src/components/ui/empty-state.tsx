'use client'

import { cn } from '@/lib/utils/cn'
import Link from 'next/link'
import { Button } from './button'

interface EmptyStateProps {
  /** Passe como JSX: icon={<Warehouse className="w-6 h-6 text-text-muted" />}
   *  NÃO passe como referência de componente (icon={Warehouse}) — viola RSC boundary */
  icon: React.ReactNode
  title: string
  description?: string
  action?: {
    label: string
    href: string
  }
  className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-16 px-6 text-center', className)}>
      <div className="w-12 h-12 rounded-2xl bg-bg-overlay flex items-center justify-center mb-4">
        {icon}
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
