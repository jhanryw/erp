import { createAdminClient } from '@/lib/supabase/admin'
import type { AppRole } from '@/types/roles'
import { hasMinRole } from '@/types/roles'
import { formatDate } from '@/lib/utils/date'
import { subDays } from 'date-fns'

export interface DashboardKpi {
  revenue: number
  orders: number
  avgTicket: number
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
  showFinancials: boolean
}

type DailySalesRow = {
  sale_date: string
  gross_revenue: number | null
  total_orders: number | null
  gross_profit?: number | null
}

type ProductPerformanceRow = {
  product_id: number
  product_name: string
  total_revenue: number | null
  total_units_sold: number | null
  realized_margin_pct: number | null
}

type StockStatusRow = {
  product_id: number
  product_name: string
  current_qty: number | null
  stock_value_at_price: number | null
}

export async function getDashboardData(role: AppRole): Promise<DashboardData> {
  const supabase = createAdminClient()

  const today = formatDate(new Date(), 'yyyy-MM-dd')
  const thirtyDaysAgo = formatDate(subDays(new Date(), 30), 'yyyy-MM-dd')
  // Gerente e admin veem métricas financeiras; usuário básico vê apenas contagens
  const showFinancials = hasMinRole(role, 'gerente')

  const [
    todaySalesRes,
    monthlySalesRes,
    dailySeriesRes,
    topProductsRes,
    stockAlertsRes,
  ] = await Promise.all([
    supabase
      .from('mv_daily_sales_summary')
      .select('gross_revenue, total_orders')
      .eq('sale_date', today)
      .maybeSingle(),
    supabase
      .from('mv_daily_sales_summary')
      .select('gross_revenue, total_orders, gross_profit')
      .gte('sale_date', thirtyDaysAgo),
    supabase
      .from('mv_daily_sales_summary')
      .select('sale_date, gross_revenue, total_orders')
      .gte('sale_date', thirtyDaysAgo)
      .order('sale_date', { ascending: true }),
    supabase
      .from('mv_product_performance')
      .select(
        'product_id, product_name, total_revenue, total_units_sold, realized_margin_pct'
      )
      .order('total_revenue', { ascending: false })
      .limit(5),
    supabase
      .from('mv_stock_status')
      .select('product_id, product_name, current_qty, stock_value_at_price')
      .lte('current_qty', 3)
      .order('current_qty', { ascending: true })
      .limit(5),
  ])

  const todayData = (todaySalesRes.data ?? null) as {
    gross_revenue?: number | null
    total_orders?: number | null
  } | null

  const monthData = (monthlySalesRes.data ?? []) as DailySalesRow[]
  const dailySeries = (dailySeriesRes.data ?? []) as DailySalesRow[]
  const topProducts = (topProductsRes.data ?? []) as ProductPerformanceRow[]
  const stockAlerts = (stockAlertsRes.data ?? []) as StockStatusRow[]

  const monthRevenue = monthData.reduce(
    (sum, row) => sum + Number(row.gross_revenue ?? 0),
    0
  )

  const monthOrders = monthData.reduce(
    (sum, row) => sum + Number(row.total_orders ?? 0),
    0
  )

  const avgTicket = monthOrders > 0 ? monthRevenue / monthOrders : 0

  const grossProfit = monthData.reduce(
    (sum, row) => sum + Number(row.gross_profit ?? 0),
    0
  )

  const grossMarginPct =
    showFinancials && monthRevenue > 0 ? (grossProfit / monthRevenue) * 100 : null

  return {
    today: {
      revenue: Number(todayData?.gross_revenue ?? 0),
      orders: Number(todayData?.total_orders ?? 0),
    },
    month: {
      revenue: monthRevenue,
      orders: monthOrders,
      avgTicket,
      grossMarginPct,
    },
    dailySeries: dailySeries.map((row) => ({
      sale_date: row.sale_date,
      gross_revenue: Number(row.gross_revenue ?? 0),
      total_orders: Number(row.total_orders ?? 0),
    })),
    topProducts: topProducts.map((row) => ({
      product_id: row.product_id,
      product_name: row.product_name,
      total_revenue: Number(row.total_revenue ?? 0),
      total_units_sold: Number(row.total_units_sold ?? 0),
      realized_margin_pct: showFinancials
        ? Number(row.realized_margin_pct ?? 0)
        : null,
    })),
    stockAlerts: stockAlerts.map((row) => ({
      product_id: row.product_id,
      product_name: row.product_name,
      current_qty: Number(row.current_qty ?? 0),
      stock_value_at_price: Number(row.stock_value_at_price ?? 0),
    })),
    showFinancials,
  }
}
