import type { ModalityComparison } from '@/lib/analytics/modalityMetrics'
import { formatCurrency } from '@/lib/utils/currency'

interface Props {
  modality: ModalityComparison
}

/**
 * Composição discreta do faturamento — Varejo × Atacado — Analytics
 * Varejo/Atacado, seção "DASHBOARD PRINCIPAL" do pedido: "quero
 * visualizar de maneira discreta... não transforme todo o dashboard numa
 * tela de atacado". Uma barra de 2 segmentos + duas linhas de texto, sem
 * card próprio — pensado pra caber como subtítulo de um StatCard
 * existente, nunca como uma seção nova de destaque.
 */
export function ModalityBreakdownWidget({ modality }: Props) {
  const { retail, wholesale } = modality
  const total = retail.revenue + wholesale.revenue

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-bg-overlay">
        {total > 0 ? (
          <>
            <div className="h-full bg-blue-500" style={{ width: `${retail.revenueSharePct}%` }} />
            <div className="h-full bg-purple-500" style={{ width: `${wholesale.revenueSharePct}%` }} />
          </>
        ) : null}
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
          Varejo {formatCurrency(retail.revenue)} ({retail.revenueSharePct.toFixed(0)}%)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-purple-500" />
          Atacado {formatCurrency(wholesale.revenue)} ({wholesale.revenueSharePct.toFixed(0)}%)
        </span>
      </div>
    </div>
  )
}
