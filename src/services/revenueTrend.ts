import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Ponto diário da série de tendência de faturamento (public.vw_daily_revenue_trend).
 * Calendário contínuo por company_id — dias sem venda vêm com revenue=0,
 * orders=0, avg_ticket=0. Médias móveis e comparações já vêm calculadas
 * pelo banco, por dia calendário (nunca "últimas N linhas com venda") —
 * nenhum cálculo de tendência deve ser refeito no frontend.
 *
 * weekday_number segue ISODOW (1=segunda ... 7=domingo), pareado com
 * week_start (segunda-feira da semana ISO).
 *
 * Campos de crescimento (*_growth_pct, vs_weekday_avg_pct) são `null`
 * quando ainda não há histórico suficiente ou o valor de referência é
 * zero — nunca 0, NaN ou Infinity.
 */
export interface RevenueTrendPoint {
  date: string
  company_id: number
  revenue: number
  orders: number
  avg_ticket: number

  mm7: number
  mm30: number
  mm7_7d_ago: number | null
  mm30_30d_ago: number | null
  mm7_growth_pct: number | null
  mm30_growth_pct: number | null

  weekday_number: number
  weekday_name: string
  weekday_recent_avg: number | null
  vs_weekday_avg_pct: number | null

  day_of_month: number
  month: number
  year: number
  month_period: 'inicio' | 'meio' | 'fim'

  iso_week: number
  week_start: string
  wtd_revenue: number
  wtd_revenue_prev_week_equivalent: number | null
  wtd_growth_pct: number | null

  mtd_revenue: number
  previous_month_same_period_revenue: number
  mtd_growth_pct: number | null
}

/**
 * Série completa de tendência de faturamento da empresa, desde o primeiro
 * dia com venda válida até hoje (fuso America/Fortaleza, calculado no
 * banco). Retorna o histórico inteiro de propósito: a view já computa
 * MM7/MM30 sobre a série completa, então qualquer recorte por período
 * (7D/30D/90D/6M/1A) deve ser feito DEPOIS, sobre o retorno desta função —
 * nunca re-buscando com um range curto, o que distorceria o primeiro ponto
 * da média móvel.
 *
 * Isolamento multi-tenant via filtro explícito de company_id — a view
 * agrega todas as empresas; quem restringe é o chamador (mesmo padrão de
 * getDashboardData em src/app/(dashboard)/dashboard/page.tsx).
 */
export async function getRevenueTrend(companyId: number): Promise<RevenueTrendPoint[]> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('vw_daily_revenue_trend' as any)
    .select('*')
    .eq('company_id', companyId)
    .order('date', { ascending: true })

  if (error) throw new Error(`getRevenueTrend: ${error.message}`)
  return (data ?? []) as unknown as RevenueTrendPoint[]
}
