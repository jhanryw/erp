import { createAdminClient } from '@/lib/supabase/admin'
import { brazilDate } from '@/lib/utils/date'

export interface TodayRevenue {
  revenue:   number
  orders:    number
  avgTicket: number
}

/**
 * Faturamento de hoje — fonte ÚNICA da regra de negócio do card "Faturamento
 * Hoje" do Dashboard (sales.sale_date = hoje em America/Fortaleza, status
 * fora de cancelled/returned). Reutilizada pelo Dashboard, pelo cron de
 * resumo diário e pelo push de nova venda — nunca duplicar este filtro em
 * outro lugar, sob risco dos três mostrarem valores diferentes.
 */
export async function getTodayRevenue(companyId: number): Promise<TodayRevenue> {
  const admin = createAdminClient()
  const today = brazilDate()

  const { data: rows } = await (admin as any)
    .from('sales')
    .select('id, total')
    .eq('company_id', companyId)
    .eq('sale_date', today)
    .not('status', 'in', '("cancelled","returned")') as { data: { id: number; total: number }[] | null }

  const salesRows = rows ?? []
  const revenue   = salesRows.reduce((sum, r) => sum + Number(r.total ?? 0), 0)
  const orders    = salesRows.length
  const avgTicket = orders > 0 ? revenue / orders : 0

  return { revenue, orders, avgTicket }
}
