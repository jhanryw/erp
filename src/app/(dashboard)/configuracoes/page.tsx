import Link from 'next/link'
import { Settings, Users, Tag, Grid3X3, BookOpen, Gift, ArrowRight, Truck } from 'lucide-react'

export const dynamic = 'force-dynamic'

const SETTINGS_SECTIONS = [
  { href: '/configuracoes/usuarios', icon: Users, title: 'Usuários', description: 'Gerenciar acesso e perfis da equipe interna.' },
  { href: '/configuracoes/categorias', icon: Tag, title: 'Categorias', description: 'Categorias e subcategorias de produtos.' },
  { href: '/configuracoes/variacoes', icon: Grid3X3, title: 'Variações', description: 'Tipos e valores: cor, tamanho, modelo, tecido.' },
  { href: '/configuracoes/colecoes', icon: BookOpen, title: 'Coleções', description: 'Coleções e estações do catálogo.' },
  { href: '/cashback/configuracao', icon: Gift, title: 'Regra de Cashback', description: 'Taxa, prazo de liberação, expiração e valor mínimo.' },
  { href: '/configuracoes/frete', icon: Truck, title: 'Configuração de Frete', description: 'Origem logística, zonas de entrega, preços e regras de frete grátis.' },
  { href: '/configuracoes/parametros', icon: Settings, title: 'Parâmetros do Sistema', description: 'Estoque mínimo, período RFM e demais parâmetros.' },
]

export default async function ConfiguracoesPage() {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Settings className="w-5 h-5 text-brand" />
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Configurações</h2>
          <p className="text-sm text-text-muted">Parâmetros e gestão do sistema</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {SETTINGS_SECTIONS.map((s) => {
          const Icon = s.icon
          return (
            <Link key={s.href} href={s.href} className="card p-5 flex flex-col gap-4 hover:border-border-strong transition-all group">
              <div className="flex items-start justify-between">
                <div className="p-2 rounded-lg bg-bg-overlay">
                  <Icon className="w-4 h-4 text-text-secondary" />
                </div>
                <ArrowRight className="w-4 h-4 text-text-muted group-hover:text-accent transition-colors" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-text-primary mb-1">{s.title}</h3>
                <p className="text-xs text-text-muted">{s.description}</p>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
