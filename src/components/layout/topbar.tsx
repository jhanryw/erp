'use client'

import { usePathname } from 'next/navigation'
import { Bell, Search } from 'lucide-react'
import { MobileNav } from './mobile-nav'

const PAGE_TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/produtos': 'Produtos',
  '/produtos/novo': 'Novo Produto',
  '/estoque': 'Estoque',
  '/estoque/movimentacoes': 'Movimentações',
  '/estoque/alertas': 'Alertas de Estoque',
  '/fornecedores': 'Fornecedores',
  '/clientes': 'Clientes',
  '/vendas': 'Vendas',
  '/vendas/nova': 'Nova Venda',
  '/marketing': 'Marketing',
  '/marketing/campanhas': 'Campanhas',
  '/marketing/custos': 'Custos de Marketing',
  '/financeiro': 'Financeiro',
  '/financeiro/fluxo': 'Fluxo de Caixa',
  '/financeiro/dre': 'DRE',
  '/cashback': 'Cashback',
  '/relatorios': 'Relatórios',
  '/inteligencia': 'Inteligência',
  '/configuracoes': 'Configurações',
}

function getTitle(pathname: string): string {
  if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname]
  // Match dynamic routes
  const parts = pathname.split('/')
  if (parts[1] && PAGE_TITLES[`/${parts[1]}`]) {
    return PAGE_TITLES[`/${parts[1]}`]
  }
  return 'Santtorini ERP'
}

export function Topbar() {
  const pathname = usePathname()

  return (
    <header className="h-14 flex items-center justify-between px-4 border-b border-border bg-bg-base/80 backdrop-blur sticky top-0 z-20">
      <div className="flex items-center gap-3">
        {/* Mobile: hamburguer */}
        <MobileNav />
        <h1 className="text-sm font-semibold text-text-primary">{getTitle(pathname)}</h1>
      </div>

      <div className="flex items-center gap-2">
        {/* Search global (futuro) */}
        <button className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors hidden sm:flex">
          <Search className="w-4 h-4" />
        </button>

        {/* Notificações (futuro) */}
        <button className="relative p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors">
          <Bell className="w-4 h-4" />
          {/* badge de contagem */}
          {/* <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-brand rounded-full" /> */}
        </button>
      </div>
    </header>
  )
}
