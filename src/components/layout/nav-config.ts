import {
  LayoutDashboard, ShoppingCart, Users, Package, Warehouse,
  Truck, TrendingUp, DollarSign, BarChart3, Brain,
  Settings, Gift, SendHorizonal, Globe, Wallet, MapPin, MessageSquare,
} from 'lucide-react'
import type { AppRole } from '@/types/roles'

export interface NavItem {
  label: string
  href: string
  icon: React.ElementType
  /** Role mínimo para ver este item. Ausente = visível para todos. */
  minRole?: AppRole
  badge?: string
}

export interface NavGroup {
  title: string
  items: NavItem[]
}

/** Fonte única dos itens de menu — usada pelo sidebar desktop e pelo drawer mobile. */
export const NAV_GROUPS: NavGroup[] = [
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
      { label: 'Caixa',  href: '/caixa',  icon: Wallet },
      { label: 'CRM',    href: '/crm/conversas', icon: MessageSquare },
      { label: 'Envios',   href: '/envios',          icon: SendHorizonal },
      { label: 'Repasses', href: '/envios/repasses', icon: Wallet },
      { label: 'Clientes', href: '/clientes', icon: Users },
      { label: 'Produtos', href: '/produtos', icon: Package },
      { label: 'Estoque',       href: '/estoque',              icon: Warehouse },
      { label: 'Localizações',  href: '/estoque/localizacoes', icon: MapPin },
      { label: 'Fornecedores', href: '/fornecedores', icon: Truck },
      { label: 'Marketing',    href: '/marketing',    icon: TrendingUp },
      { label: 'Cashback',     href: '/cashback',     icon: Gift },
    ],
  },
  {
    title: 'Gestão',
    items: [
      { label: 'Financeiro',   href: '/financeiro',   icon: DollarSign, minRole: 'gerente' },
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
      { label: 'Nuvemshop',    href: '/configuracoes/nuvemshop', icon: Globe, minRole: 'admin' },
    ],
  },
]
