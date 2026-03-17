import Link from 'next/link'
import { BarChart3, Users, Package, Truck, DollarSign, Warehouse, FileText, ArrowRight } from 'lucide-react'

export const dynamic = 'force-dynamic'

const REPORTS = [
  { href: '/relatorios/vendas', icon: BarChart3, title: 'Vendas', description: 'Faturamento, ticket médio, cancelamentos, por período e canal.', formats: ['Excel', 'PDF', 'CSV'] },
  { href: '/relatorios/produtos', icon: Package, title: 'Produtos', description: 'Performance, margem, volume vendido, ABC por produto.', formats: ['Excel', 'CSV'] },
  { href: '/relatorios/clientes', icon: Users, title: 'Clientes', description: 'Base de clientes, RFM, ticket médio, origem, cashback.', formats: ['Excel', 'CSV'] },
  { href: '/relatorios/fornecedores', icon: Truck, title: 'Fornecedores', description: 'Compras, margem, volume, giro por fornecedor.', formats: ['Excel', 'PDF'] },
  { href: '/relatorios/financeiro', icon: DollarSign, title: 'Financeiro', description: 'DRE mensal, fluxo de caixa, despesas por categoria.', formats: ['Excel', 'PDF'] },
  { href: '/relatorios/estoque', icon: Warehouse, title: 'Estoque', description: 'Posição atual, movimentações, alertas, giro.', formats: ['Excel', 'CSV'] },
  { href: '/relatorios/marketing', icon: FileText, title: 'Marketing', description: 'CAC, ROI, investimento por canal e campanha.', formats: ['Excel', 'PDF'] },
]

export default function RelatoriosPage() {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Relatórios</h2>
        <p className="text-sm text-text-muted">Exporte dados em Excel, PDF ou CSV</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {REPORTS.map((r) => {
          const Icon = r.icon
          return (
            <Link key={r.href} href={r.href} className="card p-5 flex flex-col gap-4 hover:border-brand/40 transition-all group">
              <div className="flex items-start justify-between">
                <div className="p-2.5 rounded-xl bg-bg-overlay">
                  <Icon className="w-5 h-5 text-text-secondary" />
                </div>
                <ArrowRight className="w-4 h-4 text-text-muted group-hover:text-accent transition-colors" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-text-primary mb-1">{r.title}</h3>
                <p className="text-xs text-text-muted leading-relaxed mb-3">{r.description}</p>
                <div className="flex gap-1.5">
                  {r.formats.map((f) => (
                    <span key={f} className="text-[10px] px-1.5 py-0.5 rounded bg-bg-overlay text-text-muted border border-border">
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
