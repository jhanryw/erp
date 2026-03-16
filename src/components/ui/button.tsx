import { cn } from '@/lib/utils/cn'
import { Loader2 } from 'lucide-react'
import { forwardRef } from 'react'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
  size?: 'sm' | 'md' | 'lg' | 'icon'
  loading?: boolean
}

const variants = {
  primary: 'bg-brand hover:bg-brand-light text-white shadow-sm',
  secondary: 'bg-bg-overlay hover:bg-bg-hover text-text-primary border border-border',
  ghost: 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
  danger: 'bg-error/10 hover:bg-error/20 text-error border border-error/20',
  outline: 'border border-brand text-brand hover:bg-brand/10',
}

const sizes = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-11 px-5 text-sm gap-2',
  icon: 'h-9 w-9',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', loading, disabled, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          'inline-flex items-center justify-center font-medium rounded-lg transition-colors',
          'disabled:pointer-events-none disabled:opacity-50',
          variants[variant],
          sizes[size],
          className
        )}
        {...props}
      >
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        {children}
      </button>
    )
  }
)
Button.displayName = 'Button'
