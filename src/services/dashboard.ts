/**
 * Camada de serviço para dados do dashboard.
 * Centraliza todas as queries e agrega os dados conforme o perfil do usuário.
 *
 * Regra de visibilidade:
 *  - admin   → KPIs completos (incluindo margens e dados financeiros)
 *  - seller  → KPIs operacionais apenas (faturamento, tickets, volume de vendas)
 */

import { createClient } from '@/lib/supabase/server'
import type { UserRole } from '@/types/database.types'
import { formatDate } from '@/lib/utils/date'
import { subDays } from 'date-fns'

export interface DashboardKpi {
  revenue: number
  orders: number
  avgTicket: number
  /** null para vendedores (dado financeiro restrito) */
  grossMarginPct: number | null
}

export interface DailySalesPoint {
  sale_date: string
  gross_revenue: number
  total_orders: number
}

export interface TopProduct {
  product_id: number
  product_name: string
  total_revenue: number
  total_units_sold: number
  /** null para vendedores */
  realized_margin_pct: number | null
}

export interface StockAlert {
  product_id: number
  product_name: string
  current_qty: number
  stock_value_at_price: number
}

export interface DashboardData {
  today: Pick<DashboardKpi, 'revenue' | 'orders'>
  month: DashboardKpi
  dailySeries: DailySalesPoint[]
  topProducts: TopProduct[]
  stockAlerts: StockAlert[]
  /** indica ao componente se deve renderizar colunas de margem */
  showFinancials: boolean
}

export async function getDashboardData(role: UserRole): Promise<DashboardData> {
  const supabase = createClient()
  const today = formatDate(new Date(), 'yyyy-MM-dd')
  const thirtyDaysAgo = formatDate(subDays(new Date(), 30), 'yyyy-MM-dd')
  const showFinancials = role === 'admin'

  const [todaySales, monthlySales, dailySeries, topProducts, stockAlerts] =
    await Promise.all([
      supabase
        .from('mv_daily_sales_summary')
        .select('gross_revenue, total_orders')
        .eq('sale_date', today)
        .single() as unknown as Promise<{ data: { gross_revenue: number, total_orders: number } | null, error: any }>,

      supabase
        .from('mv_daily_sales_summary')
        .select('gross_revenue, total_orders, gross_profit')
        .gte('sale_date', thirtyDaysAgo) as unknown as Promise<{ data: any[] | null, error: any }>,

      supabase
        .from('mv_daily_sales_summary')
        .select('sale_date, gross_revenue, total_orders')
        .gte('sale_date', thirtyDaysAgo)
        .order('sale_date', { ascending: true }) as unknown as Promise<{ data: any[] | null, error: any }>,

      supabase
        .from('mv_product_performance')
        .select('product_id, product_name, total_revenue, total_units_sold, realized_margin_pct')
        .order('total_revenue', { ascending: false })
        .limit(5) as unknown as Promise<{ data: any[] | null, error: any }>,

      supabase
        .from('mv_stock_status')
        .select('product_id, product_name, current_qty, stock_value_at_price')
        .lte('current_qty', 3)
        .order('current_qty', { ascending: true })
        .limit(5) as unknown as Promise<{ data: any[] | null, error: any }>,
    ])

  const todayData = todaySales.data
  const monthData = monthlySales.data ?? []
  const monthRevenue = monthData.reduce((s, r) => s + (r.gross_revenue ?? 0), 0)
  const monthOrders = monthData.reduce((s, r) => s + (r.total_orders ?? 0), 0)
  const avgTicket = monthOrders > 0 ? monthRevenue / monthOrders : 0
  const grossMarginPct =
    showFinancials && monthRevenue > 0
      ? (monthData.reduce((s, r) => s + (r.gross_profit ?? 0), 0) / monthRevenue) * 100
      : null

  return {
    today: {
      revenue: todayData?.gross_revenue ?? 0,
      orders: todayData?.total_orders ?? 0,
    },
    month: {
      revenue: monthRevenue,
      orders: monthOrders,
      avgTicket,
      grossMarginPct,
    },
    dailySeries: (dailySeries.data ?? []) as DailySalesPoint[],
    topProducts: ((topProducts.data ?? []) as any[]).map((p) => ({
      ...p,
      realized_margin_pct: showFinancials ? p.realized_margin_pct : null,
    })) as TopProduct[],
    stockAlerts: (stockAlerts.data ?? []) as StockAlert[],
    showFinancials,
  }
}
