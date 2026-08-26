/**
 * Camada de I/O — Analytics Varejo × Atacado.
 *
 * Único módulo que consulta `sales`/`sale_items` pra alimentar
 * `computeModalityComparison` (núcleo puro, `src/lib/analytics/
 * modalityMetrics.ts`). Mesmo filtro de "venda válida" já usado em
 * `dashboard.ts`/`relatorios/vendas`/`getSellerReport`:
 * `status NOT IN ('cancelled','returned')` — nunca uma segunda definição.
 *
 * Tenant isolation: `companyId` obrigatório, sempre vindo da sessão de
 * quem chama (nunca do cliente) — toda query abaixo filtra por
 * `company_id`, mesmo padrão de `dashboard.ts`.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { computeModalityComparison, type ModalityComparison, type ModalitySaleInput } from '@/lib/analytics/modalityMetrics'

type SaleItemsAgg = { gross_profit: number | null; quantity: number | null }[] | { gross_profit: number | null; quantity: number | null } | null

function aggregateItems(items: SaleItemsAgg): { grossProfit: number; itemsQuantity: number } {
  const rows = Array.isArray(items) ? items : items ? [items] : []
  return rows.reduce(
    (acc, i) => ({
      grossProfit: acc.grossProfit + Number(i.gross_profit ?? 0),
      itemsQuantity: acc.itemsQuantity + Number(i.quantity ?? 0),
    }),
    { grossProfit: 0, itemsQuantity: 0 },
  )
}

export interface ModalityComparisonOptions {
  /** Cruzamento sale_type × sales_channel (seção "CANAL" do pedido) — dois conceitos que continuam separados; isto só restringe QUAIS vendas entram, nunca reinterpreta sale_type. */
  salesChannel?: string
}

/**
 * Comparação Varejo/Atacado/Total pra um período — mesma fonte
 * (`sales` + `sale_items.gross_profit`) e mesmo filtro de venda válida já
 * usados por `getDashboardData` (`periodSalesRes`).
 */
export async function getModalityComparison(
  companyId: number,
  dateFrom: string,
  dateTo: string,
  options: ModalityComparisonOptions = {},
): Promise<ModalityComparison> {
  const admin = createAdminClient()

  let query = admin
    .from('sales')
    .select('id, sale_type, total, sale_items (gross_profit, quantity)')
    .eq('company_id', companyId)
    .gte('sale_date', dateFrom)
    .lte('sale_date', dateTo)
    .not('status', 'in', '("cancelled","returned")')

  if (options.salesChannel) {
    query = (query as any).eq('sales_channel', options.salesChannel)
  }

  const { data } = await query as unknown as {
    data: { id: number; sale_type: string | null; total: number; sale_items: SaleItemsAgg }[] | null
  }

  const rows: ModalitySaleInput[] = (data ?? []).map((row) => {
    const { grossProfit, itemsQuantity } = aggregateItems(row.sale_items)
    return {
      // sales.sale_type é NOT NULL DEFAULT 'retail' desde a fundação
      // varejo/atacado — o `?? 'retail'` aqui é só defesa (nunca deveria
      // disparar contra o banco real), nunca uma segunda regra de negócio.
      saleType: row.sale_type === 'wholesale' ? 'wholesale' : 'retail',
      total: Number(row.total ?? 0),
      grossProfit,
      itemsQuantity,
    }
  })

  return computeModalityComparison(rows)
}

export interface DailyModalityRevenuePoint {
  sale_date: string
  retailRevenue: number
  wholesaleRevenue: number
  totalRevenue: number
}

/**
 * Série diária de faturamento por modalidade — mesmo padrão de
 * `dashboard.ts` (`dailyOriginSeries`): busca linhas no período e agrupa
 * em memória, sem view/materialized view nova (o período já é limitado
 * pelo filtro de data, e a query usa o mesmo índice
 * `(company_id, sale_date, sale_type)` desta fase).
 */
export async function getDailyModalityRevenue(
  companyId: number,
  dateFrom: string,
  dateTo: string,
): Promise<DailyModalityRevenuePoint[]> {
  const admin = createAdminClient()

  const { data } = await admin
    .from('sales')
    .select('sale_date, sale_type, total')
    .eq('company_id', companyId)
    .gte('sale_date', dateFrom)
    .lte('sale_date', dateTo)
    .not('status', 'in', '("cancelled","returned")')
    .order('sale_date', { ascending: true }) as unknown as {
      data: { sale_date: string; sale_type: string | null; total: number }[] | null
    }

  const byDate: Record<string, { retail: number; wholesale: number }> = {}
  for (const row of data ?? []) {
    const d = row.sale_date
    if (!byDate[d]) byDate[d] = { retail: 0, wholesale: 0 }
    if (row.sale_type === 'wholesale') byDate[d].wholesale += Number(row.total ?? 0)
    else byDate[d].retail += Number(row.total ?? 0)
  }

  return Object.entries(byDate)
    .map(([sale_date, v]) => ({
      sale_date,
      retailRevenue: v.retail,
      wholesaleRevenue: v.wholesale,
      totalRevenue: v.retail + v.wholesale,
    }))
    .sort((a, b) => a.sale_date.localeCompare(b.sale_date))
}
