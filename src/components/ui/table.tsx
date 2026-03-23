'use client'

import { cn } from '@/lib/utils/cn'

export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full text-sm', className)}>{children}</table>
    </div>
  )
}

export function TableHeader({ children }: { children: React.ReactNode }) {
  return <thead className="border-b border-border">{children}</thead>
}

export function TableBody({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-border/50">{children}</tbody>
}

export function TableRow({
  children,
  onClick,
  className,
}: {
  children: React.ReactNode
  onClick?: () => void
  className?: string
}) {
  return (
    <tr
      onClick={onClick}
      className={cn(
        'transition-colors',
        onClick && 'cursor-pointer hover:bg-white/[0.03]',
        className
      )}
    >
      {children}
    </tr>
  )
}

export function TableHead({
  children,
  className,
  align = 'left',
}: {
  children?: React.ReactNode
  className?: string
  align?: 'left' | 'center' | 'right'
}) {
  return (
    <th
      className={cn(
        'px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wide',
        align === 'center' && 'text-center',
        align === 'right' && 'text-right',
        className
      )}
    >
      {children}
    </th>
  )
}

export function TableCell({
  children,
  className,
  align = 'left',
  muted,
  colSpan,
}: {
  children?: React.ReactNode
  className?: string
  align?: 'left' | 'center' | 'right'
  muted?: boolean
  colSpan?: number
}) {
  return (
    <td
      colSpan={colSpan}
      className={cn(
        'px-4 py-3.5',
        align === 'center' && 'text-center',
        align === 'right' && 'text-right',
        muted ? 'text-text-secondary' : 'text-text-primary',
        className
      )}
    >
      {children}
    </td>
  )
}
