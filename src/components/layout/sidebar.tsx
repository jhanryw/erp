'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, ShoppingCart, Users, Package, Warehouse,
  Truck, TrendingUp, DollarSign, BarChart3, Brain,
  Settings, Gift, LogOut, ChevronRight, Gem, SendHorizonal,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useAuth } from '@/hooks/useAuth'
import { useUserContext } from '@/components/layout/user-context'
import { hasMinRole, ROLE_LABELS } from '@/types/roles'
import type { AppRole } from '@/types/roles'

interface NavItem {
  label: string
  href: string
  icon: React.ElementType
  /** Role mínimo para ver este item. Ausente = visível para todos. */
  minRole?: AppRole
  badge?: string
}

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Geral',
    items: [
      { label: 'Dashboard', href: '/', icon: LayoutDashboard },
    ],
  },
  {
    title: 'Operação',
    items: [
      { label: 'Vendas', href: '/vendas', icon: ShoppingCart },
      { label: 'Envios', href: '/envios', icon: SendHorizonal },
      { label: 'Clientes', href: '/clientes', icon: Users },
      { label: 'Produtos', href: '/produtos', icon: Package },
      { label: 'Estoque', href: '/estoque', icon: Warehouse },
    ],
  },
  {
    title: 'Gestão',
    items: [
      { label: 'Fornecedores', href: '/fornecedores', icon: Truck,    minRole: 'gerente' },
      { label: 'Marketing',    href: '/marketing',    icon: TrendingUp, minRole: 'gerente' },
      { label: 'Financeiro',   href: '/financeiro',   icon: DollarSign, minRole: 'gerente' },
      { label: 'Cashback',     href: '/cashback',     icon: Gift,       minRole: 'gerente' },
    ],
  },
  {
    title: 'Análise',
    items: [
      { label: 'Relatórios',  href: '/relatorios',  icon: BarChart3, minRole: 'gerente' },
      { label: 'Inteligência', href: '/inteligencia', icon: Brain,    minRole: 'gerente' },
    ],
  },
  {
    title: 'Sistema',
    items: [
      { label: 'Configurações', href: '/configuracoes', icon: Settings, minRole: 'admin' },
    ],
  },
]

export function Sidebar() {
  const pathname = usePathname()
  const { signOut } = useAuth()
  const { userName, userRole } = useUserContext()

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href)

  return (
    <aside className="flex flex-col h-full w-60 bg-bg-elevated border-r border-border">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-border">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-brand">
          <Gem className="w-4 h-4 text-white" />
        </div>
        <div>
          <span className="text-sm font-bold text-text-primary tracking-wide">Santtorini</span>
          <p className="text-[10px] text-text-muted uppercase tracking-widest">ERP</p>
        </div>
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
