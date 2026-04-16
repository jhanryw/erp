'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Menu, X, LayoutDashboard, ShoppingCart, Users,
  Package, Warehouse, Truck, TrendingUp, DollarSign,
  BarChart3, Brain, Settings, Gift, Gem, Plus,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useUserContext } from '@/components/layout/user-context'
import { hasMinRole } from '@/types/roles'
import type { AppRole } from '@/types/roles'

interface MobileNavItem {
  label: string
  href: string
  icon: React.ElementType
  minRole?: AppRole
}

const MOBILE_NAV_ITEMS: MobileNavItem[] = [
  { label: 'Dashboard',    href: '/',            icon: LayoutDashboard },
  { label: 'Vendas',       href: '/vendas',       icon: ShoppingCart },
  { label: 'Clientes',     href: '/clientes',     icon: Users },
  { label: 'Produtos',     href: '/produtos',     icon: Package },
  { label: 'Estoque',      href: '/estoque',      icon: Warehouse },
  { label: 'Fornecedores', href: '/fornecedores', icon: Truck,      minRole: 'gerente' },
  { label: 'Marketing',    href: '/marketing',    icon: TrendingUp,  minRole: 'gerente' },
  { label: 'Financeiro',   href: '/financeiro',   icon: DollarSign,  minRole: 'gerente' },
  { label: 'Cashback',     href: '/cashback',     icon: Gift,        minRole: 'gerente' },
  { label: 'Relatórios',   href: '/relatorios',   icon: BarChart3,   minRole: 'gerente' },
  { label: 'Inteligência', href: '/inteligencia', icon: Brain,       minRole: 'gerente' },
  { label: 'Configurações',href: '/configuracoes',icon: Settings,    minRole: 'admin'   },
]

// 4 tabs + espaço central para o FAB
const BOTTOM_TABS_LEFT  = [
  { label: 'Home',    href: '/',        icon: LayoutDashboard },
  { label: 'Vendas',  href: '/vendas',  icon: ShoppingCart },
]
const BOTTOM_TABS_RIGHT = [
  { label: 'Clientes', href: '/clientes', icon: Users },
  { label: 'Estoque',  href: '/estoque',  icon: Warehouse },
]

export function MobileNav() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const { userRole } = useUserContext()

  const visibleItems = MOBILE_NAV_ITEMS.filter(
    (item) => !item.minRole || hasMinRole(userRole, item.minRole)
  )

  return (
    <>
      {/* Hamburger — área de toque mínima 44px */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Abrir menu"
        className="flex items-center justify-center w-11 h-11 rounded-xl text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors lg:hidden"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Drawer overlay */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <nav className="absolute left-0 top-0 bottom-0 w-72 bg-bg-elevated border-r border-border flex flex-col animate-slide-in-right">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-brand flex items-center justify-center">
                  <Gem className="w-3.5 h-3.5 text-white" />
                </div>
                <span className="text-sm font-bold text-text-primary">Santtorini</span>
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="Fechar menu"
                className="flex items-center justify-center w-9 h-9 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Atalho Nova Venda no topo do drawer */}
            <div className="px-3 pt-3 pb-1">
              <Link
                href="/vendas/nova"
                onClick={() => setOpen(false)}
                className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-brand text-white text-sm font-semibold transition-colors hover:bg-brand-light active:opacity-90"
              >
                <Plus className="w-4 h-4" />
                Nova Venda
              </Link>
            </div>

            <div className="flex-1 overflow-y-auto py-2 px-3 space-y-0.5">
              {visibleItems.map((item) => {
                const active = item.href === '/'
                  ? pathname === '/'
                  : pathname.startsWith(item.href)
                const Icon = item.icon
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className={cn(
                      'flex items-center gap-3 px-3 py-3 rounded-lg text-sm transition-colors',
                      active
                        ? 'bg-brand/15 text-brand font-medium'
                        : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                    )}
                  >
                    <Icon className="w-4 h-4 flex-shrink-0" />
                    {item.label}
                  </Link>
                )
              })}
            </div>
          </nav>
        </div>
      )}
    </>
  )
}

// Bottom tab bar — 4 itens + FAB central "Nova Venda"
export function BottomTabBar() {
  const pathname = usePathname()

  function TabItem({ tab }: { tab: { label: string; href: string; icon: React.ElementType } }) {
    const active = tab.href === '/'
      ? pathname === '/'
      : pathname.startsWith(tab.href)
    const Icon = tab.icon
    return (
      <Link
        href={tab.href}
        className={cn(
          'flex flex-col items-center justify-center gap-1 flex-1 py-2 transition-colors min-h-[56px]',
          active ? 'text-brand' : 'text-text-muted'
        )}
      >
        <Icon className="w-5 h-5" />
        <span className="text-[10px] font-medium leading-none">{tab.label}</span>
      </Link>
    )
  }

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-bg-elevated border-t border-border lg:hidden z-30">
      <div className="flex items-center h-16">
        {BOTTOM_TABS_LEFT.map((tab) => (
          <TabItem key={tab.href} tab={tab} />
        ))}

        {/* FAB central — Nova Venda */}
        <div className="flex flex-col items-center justify-center flex-1">
          <Link
            href="/vendas/nova"
            aria-label="Nova Venda"
            className={cn(
              'relative -top-4 w-14 h-14 rounded-full bg-brand flex items-center justify-center shadow-elevated transition-transform active:scale-95',
              pathname.startsWith('/vendas/nova') && 'ring-2 ring-white/20'
            )}
          >
            <Plus className="w-6 h-6 text-white" />
          </Link>
        </div>

        {BOTTOM_TABS_RIGHT.map((tab) => (
          <TabItem key={tab.href} tab={tab} />
        ))}
      </div>
    </nav>
  )
}
