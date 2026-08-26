/**
 * Produto por modalidade — Analytics Varejo/Atacado.
 *
 * Não usa `mv_product_performance` (a materialized view do relatório de
 * produtos existente): ela não tem `sale_type` nem filtro de período — é
 * um acumulado histórico total. Consulta direta em `sale_items`/`sales`,
 * mesmo padrão de fallback já usado em `dashboard.ts` ("top produtos, base
 * tables"). `total_price`/`gross_profit` são SNAPSHOTS gravados no
 * momento da venda — preço REALIZADO, nunca o preço atual do catálogo
 * (auditado: `products.base_price` não é lido aqui em nenhum ponto).
 */

import { createAdminClient } from '@/lib/supabase/admin'

export interface ProductModalityRow {
  product_id: number
  product_name: string
  unitsSold: number
  revenue: number
  cmv: number
  grossProfit: number
  marginPct: number | null
}

export async function getProductModalityBreakdown(
  companyId: number,
  dateFrom: string,
  dateTo: string,
  saleType?: 'retail' | 'wholesale',
): Promise<ProductModalityRow[]> {
  const admin = createAdminClient()

  let salesQuery = admin
    .from('sales')
    .select('id')
    .eq('company_id', companyId)
    .gte('sale_date', dateFrom)
    .lte('sale_date', dateTo)
    .not('status', 'in', '("cancelled","returned")')

  if (saleType) salesQuery = (salesQuery as any).eq('sale_type', saleType)

  const { data: saleRows } = await salesQuery as unknown as { data: { id: number }[] | null }
  const saleIds = (saleRows ?? []).map((s) => s.id)
  if (saleIds.length === 0) return []

  const { data: itemRows } = await (admin as any)
    .from('sale_items')
    .select(`
      quantity, total_price, gross_profit,
      product_variations!inner (
        product_id,
        products!inner (id, name, company_id)
      )
    `)
    .in('sale_id', saleIds)
    // Redundante com o filtro de sale_id (que já vem de vendas da empresa),
    // mas explícito de propósito — nunca confia em só um lado do join pra
    // isolamento de tenant (mesmo padrão de fiscal_document_items.company_id).
    .eq('product_variations.products.company_id', companyId) as { data: any[] | null }

  const byProduct: Record<number, { name: string; units: number; revenue: number; grossProfit: number }> = {}
  for (const row of itemRows ?? []) {
    const pv = row.product_variations
    const prod = Array.isArray(pv?.products) ? pv.products[0] : pv?.products
    const pid = prod?.id ?? pv?.product_id
    if (!pid) continue
    if (!byProduct[pid]) byProduct[pid] = { name: prod?.name ?? 'Produto', units: 0, revenue: 0, grossProfit: 0 }
    byProduct[pid].units += Number(row.quantity ?? 0)
    byProduct[pid].revenue += Number(row.total_price ?? 0)
    byProduct[pid].grossProfit += Number(row.gross_profit ?? 0)
  }

  return Object.entries(byProduct)
    .map(([pid, v]) => ({
      product_id: Number(pid),
      product_name: v.name,
      unitsSold: v.units,
      revenue: v.revenue,
      cmv: v.revenue - v.grossProfit,
      grossProfit: v.grossProfit,
      marginPct: v.revenue > 0 ? (v.grossProfit / v.revenue) * 100 : null,
    }))
    .sort((a, b) => b.revenue - a.revenue)
}
