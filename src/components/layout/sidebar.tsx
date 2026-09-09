'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LogOut, ChevronRight, Gem, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useAuth } from '@/hooks/useAuth'
import { useUserContext } from '@/components/layout/user-context'
import { hasMinRole, ROLE_LABELS } from '@/types/roles'
import { NAV_GROUPS } from '@/components/layout/nav-config'

interface SidebarProps {
  /** Chamado ao clicar em um item de navegação (usado pelo drawer mobile para fechar). */
  onNavigate?: () => void
  /** Quando definido, exibe um botão de fechar no cabeçalho (uso em drawer mobile). */
  onClose?: () => void
  className?: string
}

export function Sidebar({ onNavigate, onClose, className }: SidebarProps = {}) {
  const pathname = usePathname()
  const { signOut } = useAuth()
  const { userName, userRole } = useUserContext()

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href)

  return (
    <aside className={cn('flex flex-col h-full w-60 bg-bg-elevated border-r border-border', className)}>
      {/* Logo */}
      <div className="flex items-center justify-between gap-3 px-5 py-5 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-brand">
            <Gem className="w-4 h-4 text-white" />
          </div>
          <div>
            <span className="text-sm font-bold text-text-primary tracking-wide">Santtorini</span>
            <p className="text-[10px] text-text-muted uppercase tracking-widest">ERP</p>
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Fechar menu"
            className="flex items-center justify-center w-9 h-9 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-3 space-y-0.5">
        {NAV_GROUPS.map((group) => {
          const visibleItems = group.items.filter(
            (item) => !item.minRole || hasMinRole(userRole, item.minRole)
          )
          if (visibleItems.length === 0) return null

          return (
            <div key={group.title} className="mb-3">
              <p className="px-3 py-1.5 text-[10px] font-semibold text-text-muted uppercase tracking-widest">
                {group.title}
              </p>
              {visibleItems.map((item) => {
                const active = isActive(item.href)
                const Icon = item.icon
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors group',
                      active
                        ? 'bg-brand/15 text-brand font-medium'
                        : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                    )}
                  >
                    <Icon
                      className={cn(
                        'w-4 h-4 flex-shrink-0',
                        active ? 'text-brand' : 'text-text-muted group-hover:text-text-secondary'
                      )}
                    />
                    <span className="flex-1">{item.label}</span>
                    {active && (
                      <ChevronRight className="w-3.5 h-3.5 text-brand/60" />
                    )}
                    {item.badge && (
                      <span className="text-[10px] bg-brand text-white px-1.5 py-0.5 rounded-full font-medium">
                        {item.badge}
                      </span>
                    )}
                  </Link>
                )
              })}
            </div>
          )
        })}
      </nav>

      {/* User footer */}
      <div className="border-t border-border p-3">
        <div className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-bg-hover transition-colors">
          <div className="w-7 h-7 rounded-full bg-brand/20 flex items-center justify-center flex-shrink-0">
            <span className="text-xs font-bold text-accent">
              {userName?.charAt(0)?.toUpperCase() ?? 'U'}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-text-primary truncate">{userName}</p>
            <p className="text-[10px] text-text-muted capitalize">{ROLE_LABELS[userRole]}</p>
          </div>
          <button
            onClick={signOut}
            className="p-1 rounded text-text-muted hover:text-error transition-colors"
            title="Sair"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </aside>
  )
}
