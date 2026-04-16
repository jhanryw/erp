import { createAdminClient } from '@/lib/supabase/admin'
import type { AppRole } from '@/types/roles'
import { hasMinRole } from '@/types/roles'
import { subDays, format } from 'date-fns'

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

// Consulta tabelas base diretamente — sem depender de materialized views
// para garantir dados sempre atualizados.
export async function getDashboardData(role: AppRole): Promise<DashboardData> {
  const supabase = createAdminClient()
  const showFinancials = hasMinRole(role, 'gerente')

  const today         = format(new Date(), 'yyyy-MM-dd')
  const thirtyDaysAgo = format(subDays(new Date(), 30), 'yyyy-MM-dd')

  // ── Consultas em paralelo ─────────────────────────────────────────────────
  const [
    todaySalesRes,
    monthlySalesRes,
    dailySeriesRes,
    topProductsRes,
    stockAlertsRes,
  ] = await Promise.all([

    // Vendas de hoje (base: tabela sales)
    supabase
      .from('sales')
      .select('id, total')
      .eq('sale_date', today)
      .not('status', 'in', '("cancelled","returned")')
    ,

    // Vendas dos últimos 30 dias com lucro (via sale_items)
    supabase
      .from('sales')
      .select(`
        id,
        sale_date,
        total,
        sale_items (gross_profit)
      `)
      .gte('sale_date', thirtyDaysAgo)
      .not('status', 'in', '("cancelled","returned")')
    ,

    // Série diária — agrupamento feito no JS abaixo
    supabase
      .from('sales')
      .select('sale_date, total')
      .gte('sale_date', thirtyDaysAgo)
      .not('status', 'in', '("cancelled","returned")')
      .order('sale_date', { ascending: true })
    ,

    // Top produtos: usa mv_product_performance se disponível,
    // senão usa tabelas base
    supabase
      .from('mv_product_performance')
      .select('product_id, product_name, total_revenue, total_units_sold, realized_margin_pct')
      .gt('total_revenue', 0)
      .order('total_revenue', { ascending: false })
      .limit(5)
    ,

    // Alertas de estoque — mv_stock_status é uma VIEW normal (sempre fresca)
    supabase
      .from('mv_stock_status')
      .select('product_id, product_name, current_qty, stock_value_at_price')
      .lte('current_qty', 3)
      .gt('current_qty', 0)
      .order('current_qty', { ascending: true })
      .limit(6)
    ,
  ])

  // ── Hoje ─────────────────────────────────────────────────────────────────
  const todayRows   = (todaySalesRes.data ?? []) as { id: number; total: number }[]
  const todayRevenue = todayRows.reduce((s, r) => s + Number(r.total ?? 0), 0)
  const todayOrders  = todayRows.length

  // ── Mês (30 dias) ─────────────────────────────────────────────────────────
  type SaleRow = {
    id: number
    sale_date: string
    total: number
    sale_items: { gross_profit: number | null }[] | { gross_profit: number | null } | null
  }
  const monthRows   = (monthlySalesRes.data ?? []) as SaleRow[]
  const monthRevenue = monthRows.reduce((s, r) => s + Number(r.total ?? 0), 0)
  const monthOrders  = monthRows.length
  const avgTicket    = monthOrders > 0 ? monthRevenue / monthOrders : 0

  const grossProfit  = monthRows.reduce((s, r) => {
    const items = Array.isArray(r.sale_items) ? r.sale_items : r.sale_items ? [r.sale_items] : []
    return s + items.reduce((si, i) => si + Number(i.gross_profit ?? 0), 0)
  }, 0)
  const grossMarginPct = showFinancials && monthRevenue > 0
    ? (grossProfit / monthRevenue) * 100
    : null

  // ── Série diária — agrupa no JS ──────────────────────────────────────────
  type DailyRow = { sale_date: string; total: number }
  const dailyRows = (dailySeriesRes.data ?? []) as DailyRow[]
  const dailyMap  = dailyRows.reduce<Record<string, { revenue: number; orders: number }>>((acc, r) => {
    const d = r.sale_date
    if (!acc[d]) acc[d] = { revenue: 0, orders: 0 }
    acc[d].revenue += Number(r.total ?? 0)
    acc[d].orders  += 1
    return acc
  }, {})
  const dailySeries: DailySalesPoint[] = Object.entries(dailyMap)
    .map(([sale_date, v]) => ({ sale_date, gross_revenue: v.revenue, total_orders: v.orders }))
    .sort((a, b) => a.sale_date.localeCompare(b.sale_date))

  // ── Top produtos — tenta mv primeiro, cai para tabelas base se vazia ─────
  type MvProduct = {
    product_id: number
    product_name: string
    total_revenue: number | null
    total_units_sold: number | null
    realized_margin_pct: number | null
  }

  let topProductRows = (topProductsRes.data ?? []) as MvProduct[]

  // Fallback: se a materialized view estiver vazia, busca nas tabelas base
  if (topProductRows.length === 0) {
    const { data: baseTop } = await supabase
      .from('sale_items')
      .select(`
        product_variation_id,
        quantity,
        total_price,
        gross_profit,
        product_variations!inner (
          product_id,
          products!inner (id, name)
        ),
        sales!inner (sale_date, status)
      `)
      .not('sales.status', 'in', '("cancelled","returned")')
      .gte('sales.sale_date', thirtyDaysAgo)
      .limit(200) as unknown as { data: any[] | null }

    if (baseTop && baseTop.length > 0) {
      const productMap: Record<number, { product_id: number; product_name: string; total_revenue: number; total_units_sold: number; total_profit: number }> = {}

      for (const row of baseTop) {
        const pv   = row.product_variations as any
        const prod = Array.isArray(pv?.products) ? pv.products[0] : pv?.products
        const pid  = prod?.id ?? pv?.product_id
        const pname = prod?.name ?? 'Produto'

        if (!pid) continue
        if (!productMap[pid]) {
          productMap[pid] = { product_id: pid, product_name: pname, total_revenue: 0, total_units_sold: 0, total_profit: 0 }
        }
        productMap[pid].total_revenue     += Number(row.total_price ?? 0)
        productMap[pid].total_units_sold  += Number(row.quantity ?? 0)
        productMap[pid].total_profit      += Number(row.gross_profit ?? 0)
      }

      topProductRows = Object.values(productMap)
        .sort((a, b) => b.total_revenue - a.total_revenue)
        .slice(0, 5)
        .map(p => ({
          product_id: p.product_id,
          product_name: p.product_name,
          total_revenue: p.total_revenue,
          total_units_sold: p.total_units_sold,
          realized_margin_pct: p.total_revenue > 0 ? (p.total_profit / p.total_revenue) * 100 : null,
        }))
    }
  }

  // ── Montar resposta ───────────────────────────────────────────────────────
  return {
    today: {
      revenue: todayRevenue,
      orders:  todayOrders,
    },
    month: {
      revenue: monthRevenue,
      orders:  monthOrders,
      avgTicket,
      grossMarginPct,
    },
    dailySeries,
    topProducts: topProductRows.map(row => ({
      product_id:        row.product_id,
      product_name:      row.product_name,
      total_revenue:     Number(row.total_revenue ?? 0),
      total_units_sold:  Number(row.total_units_sold ?? 0),
      realized_margin_pct: showFinancials
        ? (row.realized_margin_pct != null ? Number(row.realized_margin_pct) : null)
        : null,
    })),
    stockAlerts: ((stockAlertsRes.data ?? []) as any[]).map(row => ({
      product_id:          row.product_id,
      product_name:        row.product_name,
      current_qty:         Number(row.current_qty ?? 0),
      stock_value_at_price: Number(row.stock_value_at_price ?? 0),
    })),
    showFinancials,
  }
}
