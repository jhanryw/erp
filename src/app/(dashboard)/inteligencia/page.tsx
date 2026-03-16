import Link from 'next/link'
import { BarChart3, TrendingUp, Warehouse, Palette, Truck, Users, Brain, ArrowRight } from 'lucide-react'

const MODULES = [
  {
    href: '/inteligencia/abc',
    icon: BarChart3,
    title: 'Curva ABC',
    description: 'Classifique produtos por faturamento, lucro e volume. Identifique os 20% que geram 80% dos resultados.',
    color: 'text-brand bg-brand/10',
  },
  {
    href: '/inteligencia/giro',
    icon: Warehouse,
    title: 'Giro de Estoque',
    description: 'Dias médios para vender, produtos parados, fornecedores com maior imobilização.',
    color: 'text-warning bg-warning/10',
  },
  {
    href: '/inteligencia/margem',
    icon: TrendingUp,
    title: 'Margem e Lucro',
    description: 'Margem realizada por produto e categoria. Compare margem planejada vs. efetiva.',
    color: 'text-success bg-success/10',
  },
  {
    href: '/inteligencia/cores',
    icon: Palette,
    title: 'Performance por Cor',
    description: 'Faturamento, volume e ticket médio por cor. Identifique quais cores mais vendem.',
    color: 'text-info bg-info/10',
  },
  {
    href: '/inteligencia/fornecedores',
    icon: Truck,
    title: 'Ranking de Fornecedores',
    description: 'Compare fornecedores por margem, volume, faturamento e giro de estoque.',
    color: 'text-accent bg-accent/10',
  },
  {
    href: '/inteligencia/rfm',
    icon: Users,
    title: 'Mapa RFM',
    description: 'Segmentação de clientes por recência, frequência e valor. Identifique campeões e clientes em risco.',
    color: 'text-purple-400 bg-purple-500/10',
  },
]

export default function InteligenciaPage() {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Brain className="w-5 h-5 text-brand" />
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Inteligência de Negócio</h2>
          <p className="text-sm text-text-muted">Análises avançadas para tomada de decisão</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {MODULES.map((mod) => {
          const Icon = mod.icon
          return (
            <Link
              key={mod.href}
              href={mod.href}
              className="card p-5 flex flex-col gap-4 hover:border-brand/40 transition-all group"
            >
              <div className="flex items-start justify-between">
                <div className={`p-2.5 rounded-xl ${mod.color}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <ArrowRight className="w-4 h-4 text-text-muted group-hover:text-accent transition-colors" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-text-primary mb-1">{mod.title}</h3>
                <p className="text-xs text-text-muted leading-relaxed">{mod.description}</p>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
