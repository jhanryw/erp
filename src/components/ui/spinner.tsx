import { cn } from '@/lib/utils/cn'
import { Loader2 } from 'lucide-react'

export function Spinner({ className, size = 'md' }: { className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: 'w-4 h-4', md: 'w-6 h-6', lg: 'w-8 h-8' }
  return <Loader2 className={cn('animate-spin text-brand', sizes[size], className)} />
}

export function FullPageSpinner() {
  return (
    <div className="fixed inset-0 bg-bg-root flex items-center justify-center z-50">
      <div className="flex flex-col items-center gap-3">
        <Spinner size="lg" />
        <p className="text-sm text-text-muted">Carregando...</p>
      </div>
    </div>
  )
}
