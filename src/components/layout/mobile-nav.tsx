'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Menu, X, LayoutDashboard, ShoppingCart, Users,
  Package, Warehouse, Truck, TrendingUp, DollarSign,
  BarChart3, Brain, Settings, Gift, Gem,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useUserContext } from '@/components/layout/user-context'
import { hasMinRole } from '@/types/roles'
import type { AppRole } from '@/types/roles'

interface MobileNavItem {
  label: string
  href: string
  icon: React.ElementType
  /** Role mínimo para ver este item. Ausente = visível para todos. */
  minRole?: AppRole
}

const MOBILE_NAV_ITEMS: MobileNavItem[] = [
  { label: 'Dashboard',    href: '/',            icon: LayoutDashboard },
  { label: 'Vendas',       href: '/vendas',       icon: ShoppingCart },
  { label: 'Clientes',     href: '/clientes',     icon: Users },
  { label: 'Produtos',     href: '/produtos',     icon: Package },
  { label: 'Estoque',      href: '/estoque',      icon: Warehouse },
  { label: 'Fornecedores', href: '/fornecedores', icon: Truck,     minRole: 'gerente' },
  { label: 'Marketing',    href: '/marketing',    icon: TrendingUp, minRole: 'gerente' },
  { label: 'Financeiro',   href: '/financeiro',   icon: DollarSign, minRole: 'gerente' },
  { label: 'Cashback',     href: '/cashback',     icon: Gift,       minRole: 'gerente' },
  { label: 'Relatórios',   href: '/relatorios',   icon: BarChart3,  minRole: 'gerente' },
  { label: 'Inteligência', href: '/inteligencia', icon: Brain,      minRole: 'gerente' },
  { label: 'Configurações',href: '/configuracoes',icon: Settings,   minRole: 'admin'   },
]

// Bottom tab bar — 4 itens fixos, sempre visíveis
const BOTTOM_TABS = [
  { label: 'Home',    href: '/',       icon: LayoutDashboard },
  { label: 'Vendas',  href: '/vendas', icon: ShoppingCart },
  { label: 'Clientes',href: '/clientes',icon: Users },
  { label: 'Estoque', href: '/estoque', icon: Warehouse },
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
      {/* Hamburger — visível apenas em mobile */}
      <button
        onClick={() => setOpen(true)}
        className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors lg:hidden"
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
          <nav className="absolute left-0 top-0 bottom-0 w-64 bg-bg-elevated border-r border-border flex flex-col animate-slide-in-right">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-brand flex items-center justify-center">
                  <Gem className="w-3.5 h-3.5 text-white" />
                </div>
                <span className="text-sm font-bold text-text-primary">Santtorini</span>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="p-1 rounded text-text-muted hover:text-text-primary"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto py-3 px-3 space-y-1">
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
                      'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors',
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

// Bottom tab bar para mobile — sem restrição de role (itens básicos)
export function BottomTabBar() {
  const pathname = usePathname()

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-bg-elevated border-t border-border lg:hidden z-30 pb-safe">
      <div className="flex items-center justify-around px-2 py-2">
        {BOTTOM_TABS.map((tab) => {
          const active = tab.href === '/'
            ? pathname === '/'
            : pathname.startsWith(tab.href)
          const Icon = tab.icon
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                'flex flex-col items-center gap-1 px-3 py-1 rounded-lg transition-colors min-w-[60px]',
                active ? 'text-brand' : 'text-text-muted'
              )}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium">{tab.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
