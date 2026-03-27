import { cn } from '@/lib/utils/cn'
import type { SaleStatus, RfmSegment } from '@/types/database.types'

interface BadgeProps {
  children: React.ReactNode
  variant?:
    | 'default'
    | 'success'
    | 'warning'
    | 'error'
    | 'info'
    | 'brand'
    | 'outline'
    | 'secondary'
  size?: 'sm' | 'md'
  className?: string
}

const badgeVariants = {
  default: 'bg-bg-overlay text-text-secondary border border-border',
  secondary: 'bg-bg-overlay text-text-secondary border border-border',
  success: 'bg-success/10 text-success border border-success/20',
  warning: 'bg-warning/10 text-warning border border-warning/20',
  error: 'bg-error/10 text-error border border-error/20',
  info: 'bg-info/10 text-info border border-info/20',
  brand: 'bg-brand/10 text-brand border border-brand/20',
  outline: 'border border-border text-text-secondary',
}

const badgeSizes = {
  sm: 'px-1.5 py-0.5 text-[10px]',
  md: 'px-2 py-1 text-xs',
}

export function Badge({
  children,
  variant = 'default',
  size = 'md',
  className,
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full font-medium',
        badgeVariants[variant],
        badgeSizes[size],
        className
      )}
    >
      {children}
    </span>
  )
}

export function SaleStatusBadge({ status }: { status: SaleStatus }) {
  const config: Record<
    SaleStatus,
    { label: string; variant: BadgeProps['variant'] }
  > = {
    pending: { label: 'Pendente', variant: 'warning' },
    paid: { label: 'Pago', variant: 'success' },
    shipped: { label: 'Enviado', variant: 'info' },
    delivered: { label: 'Entregue', variant: 'default' },
    cancelled: { label: 'Cancelado', variant: 'error' },
    returned: { label: 'Devolvido', variant: 'warning' },
  }

  const { label, variant } = config[status]
  return <Badge variant={variant}>{label}</Badge>
}

export function RfmBadge({ segment }: { segment: RfmSegment }) {
  const config: Record<RfmSegment, { label: string; className: string }> = {
    champions: {
      label: 'Champions',
      className: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    },
    loyal: {
      label: 'Leal',
      className: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    },
    potential_loyal: {
      label: 'Potencial',
      className: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
    },
    new_customers: {
      label: 'Novo',
      className: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
    },
    promising: {
      label: 'Promissor',
      className: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
    },
    at_risk: {
      label: 'Em Risco',
      className: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
    },
    cant_lose: {
      label: 'Não Perca',
      className: 'bg-red-500/10 text-red-400 border-red-500/20',
    },
    hibernating: {
      label: 'Hibernando',
      className: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
    },
    lost: {
      label: 'Perdido',
      className: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
    },
  }

  const { label, className } = config[segment]

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium',
        className
      )}
    >
      {label}
    </span>
  )
}