import type { ModalityComparison, ModalityMetrics } from '@/lib/analytics/modalityMetrics'
import { formatCurrency } from '@/lib/utils/currency'

interface Props {
  comparison: ModalityComparison
}

function pct(n: number | null) {
  return n != null ? `${n.toFixed(1)}%` : '—'
}

const ROWS: { key: keyof ModalityMetrics; label: string; format: (m: ModalityMetrics) => string }[] = [
  { key: 'revenue', label: 'Faturamento', format: (m) => formatCurrency(m.revenue) },
  { key: 'orders', label: 'Vendas', format: (m) => String(m.orders) },
  { key: 'avgTicket', label: 'Ticket médio', format: (m) => formatCurrency(m.avgTicket) },
  { key: 'itemsSold', label: 'Itens vendidos', format: (m) => String(m.itemsSold) },
  { key: 'cmv', label: 'CMV', format: (m) => formatCurrency(m.cmv) },
  { key: 'grossProfit', label: 'Lucro bruto', format: (m) => formatCurrency(m.grossProfit) },
  { key: 'grossMarginPct', label: 'Margem bruta', format: (m) => pct(m.grossMarginPct) },
  { key: 'revenueSharePct', label: 'Participação receita', format: (m) => `${m.revenueSharePct.toFixed(1)}%` },
  { key: 'grossProfitSharePct', label: 'Participação lucro bruto', format: (m) => `${m.grossProfitSharePct.toFixed(1)}%` },
]

/**
 * Visão principal — Varejo × Atacado × Total. "Lucro bruto"/"margem
 * bruta", NUNCA "lucro líquido"/"resultado líquido" (seção "NÃO CHAMAR DE
 * LUCRO LÍQUIDO" do pedido — despesas operacionais continuam
 * compartilhadas, fora do escopo desta tabela).
 */
export function ModalityComparisonTable({ comparison }: Props) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-wider">Métrica</th>
            <th className="text-right px-4 py-3 text-xs font-semibold text-blue-500 uppercase tracking-wider">Varejo</th>
            <th className="text-right px-4 py-3 text-xs font-semibold text-purple-500 uppercase tracking-wider">Atacado</th>
            <th className="text-right px-4 py-3 text-xs font-semibold text-text-primary uppercase tracking-wider">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {ROWS.map((row) => (
            <tr key={row.key} className="hover:bg-bg-hover transition-colors">
              <td className="px-4 py-2.5 text-text-secondary">{row.label}</td>
              <td className="px-4 py-2.5 text-right tabular-nums font-medium">{row.format(comparison.retail)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums font-medium">{row.format(comparison.wholesale)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-text-primary">{row.format(comparison.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-text-muted px-4 py-3">
        Lucro bruto = receita − CMV. Não inclui despesas operacionais (aluguel, folha, marketing) — a DRE permanece consolidada, sem rateio por modalidade.
      </p>
    </div>
  )
}
