import { createAdminClient } from '@/lib/supabase/admin'
import { brazilDate, brazilSubDays } from '@/lib/utils/date'
import { ORIGIN_LABELS } from '@/lib/constants/origins'
export { ORIGIN_LABELS, ORIGIN_COLORS, ALL_ORIGINS } from '@/lib/constants/origins'

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

export interface OriginStat {
  origin: string
  label: string
  revenue: number
  orders: number
  pct: number
}

export interface SellerStat {
  sellerId: number
  sellerName: string
  revenue: number
  pct: number
}

export interface DailyOriginPoint {
  sale_date: string
  [key: string]: number | string
}

export interface DashboardData {
  today: Pick<DashboardKpi, 'revenue' | 'orders'>
  period: DashboardKpi
  dailySeries: DailySalesPoint[]
  originBreakdown: OriginStat[]
  dailyOriginSeries: DailyOriginPoint[]
  sellerBreakdown: SellerStat[]
  topProducts: TopProduct[]
  stockAlerts: StockAlert[]
  dateRange: { from: string; to: string }
}

// Consulta tabelas base diretamente — sem depender de materialized views
// para garantir dados sempre atualizados.
//
// Tenant isolation: companyId é OBRIGATÓRIO e deve vir sempre da sessão
// autenticada (profile.company_id em quem chama), nunca de input do
// cliente. Toda consulta abaixo filtra por company_id — inclusive
// mv_product_performance e mv_stock_status, que passaram a ter a coluna
// via 20260812_add_company_id_dashboard_mvs.sql (antes eram agregados
// globais sem isolamento nenhum).
//
// Conteúdo do Dashboard não depende mais de role (Dashboard não é módulo
// bloqueado — usuario = admin aqui). showFinancials foi removido.
export async function getDashboardData(
  companyId: number,
  dateFrom?: string,
  dateTo?: string,
): Promise<DashboardData> {
  const supabase = createAdminClient()

  const today = brazilDate()
  const from  = dateFrom ?? brazilSubDays(29)
  const to    = dateTo   ?? today

  // ── Consultas em paralelo ─────────────────────────────────────────────────
  const [
    todaySalesRes,
    periodSalesRes,
    dailySeriesRes,
    originSeriesRes,
    topProductsRes,
    stockAlertsRes,
    sellerSalesRes,
    sellersRes,
  ] = await Promise.all([

    // Vendas de hoje (sempre hoje, independente do range)
    supabase
      .from('sales')
      .select('id, total')
      .eq('company_id', companyId)
      .eq('sale_date', today)
      .not('status', 'in', '("cancelled","returned")')
    ,

    // Vendas do período selecionado com lucro (via sale_items)
    supabase
      .from('sales')
      .select(`
        id,
        sale_date,
        total,
        sale_items (gross_profit)
      `)
      .eq('company_id', companyId)
      .gte('sale_date', from)
      .lte('sale_date', to)
      .not('status', 'in', '("cancelled","returned")')
    ,

    // Série diária total — agrupamento feito no JS abaixo
    supabase
      .from('sales')
      .select('sale_date, total')
      .eq('company_id', companyId)
      .gte('sale_date', from)
      .lte('sale_date', to)
      .not('status', 'in', '("cancelled","returned")')
      .order('sale_date', { ascending: true })
    ,

    // Origem de venda por dia — para gráfico empilhado e breakdown
    supabase
      .from('sales')
      .select('sale_date, sale_origin, total')
      .eq('company_id', companyId)
      .gte('sale_date', from)
      .lte('sale_date', to)
      .not('status', 'in', '("cancelled","returned")')
      .order('sale_date', { ascending: true })
    ,

    // Top produtos: usa mv_product_performance se disponível,
    // senão usa tabelas base. company_id agora existe na MV
    // (20260812_add_company_id_dashboard_mvs.sql).
    supabase
      .from('mv_product_performance')
      .select('product_id, product_name, total_revenue, total_units_sold, realized_margin_pct')
      .eq('company_id', companyId)
      .gt('total_revenue', 0)
      .order('total_revenue', { ascending: false })
      .limit(5)
    ,

    // Alertas de estoque — mv_stock_status é materializada; company_id
    // agora existe (20260812_add_company_id_dashboard_mvs.sql).
    supabase
      .from('mv_stock_status')
      .select('product_id, product_name, current_qty, stock_value_at_price')
      .eq('company_id', companyId)
      .lte('current_qty', 3)
      .gt('current_qty', 0)
      .order('current_qty', { ascending: true })
      .limit(6)
    ,

    // Faturamento por vendedor responsável no período
    // Usa responsible_seller_id (quem fez a venda), nunca o login
    supabase
      .from('sales')
      .select('responsible_seller_id, subtotal, discount_amount, cashback_used')
      .eq('company_id', companyId)
      .gte('sale_date', from)
      .lte('sale_date', to)
      .not('status', 'in', '("cancelled","returned")')
    ,

    // Todos os sellers da empresa — sem filtro active, para que inativos
    // (ex: Santtorini) apareçam nos relatórios históricos quando houver
    // vendas atribuídas a eles
    supabase
      .from('sellers')
      .select('id, name')
      .eq('company_id', companyId)
      .order('name')
    ,
  ])

  // ── Hoje ─────────────────────────────────────────────────────────────────
  const todayRows    = (todaySalesRes.data ?? []) as { id: number; total: number }[]
  const todayRevenue = todayRows.reduce((s, r) => s + Number(r.total ?? 0), 0)
  const todayOrders  = todayRows.length

  // ── Período ───────────────────────────────────────────────────────────────
  type SaleRow = {
    id: number
    sale_date: string
    total: number
    sale_items: { gross_profit: number | null }[] | { gross_profit: number | null } | null
  }
  const periodRows    = (periodSalesRes.data ?? []) as SaleRow[]
  const periodRevenue = periodRows.reduce((s, r) => s + Number(r.total ?? 0), 0)
  const periodOrders  = periodRows.length
  const avgTicket     = periodOrders > 0 ? periodRevenue / periodOrders : 0

  const grossProfit    = periodRows.reduce((s, r) => {
    const items = Array.isArray(r.sale_items) ? r.sale_items : r.sale_items ? [r.sale_items] : []
    return s + items.reduce((si, i) => si + Number(i.gross_profit ?? 0), 0)
  }, 0)
  const grossMarginPct = periodRevenue > 0
    ? (grossProfit / periodRevenue) * 100
    : null

  // ── Série diária total — agrupa no JS ────────────────────────────────────
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

  // ── Origem de venda ───────────────────────────────────────────────────────
  type OriginRow = { sale_date: string; sale_origin: string | null; total: number }
  const originRows = (originSeriesRes.data ?? []) as OriginRow[]

  // Breakdown total por origem
  const originTotals: Record<string, { revenue: number; orders: number }> = {}
  for (const r of originRows) {
    const key = r.sale_origin ?? 'unknown'
    if (!originTotals[key]) originTotals[key] = { revenue: 0, orders: 0 }
    originTotals[key].revenue += Number(r.total ?? 0)
    originTotals[key].orders  += 1
  }

  const originBreakdown: OriginStat[] = Object.entries(originTotals)
    .map(([origin, v]) => ({
      origin,
      label:   ORIGIN_LABELS[origin] ?? origin,
      revenue: v.revenue,
      orders:  v.orders,
      pct:     periodRevenue > 0 ? (v.revenue / periodRevenue) * 100 : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue)

  // Série diária por origem — wide format para gráfico empilhado
  const originDailyMap: Record<string, Record<string, number>> = {}
  for (const r of originRows) {
    const d   = r.sale_date
    const key = r.sale_origin ?? 'unknown'
    if (!originDailyMap[d]) originDailyMap[d] = {}
    originDailyMap[d][key] = (originDailyMap[d][key] ?? 0) + Number(r.total ?? 0)
  }
  const dailyOriginSeries: DailyOriginPoint[] = Object.entries(originDailyMap)
    .map(([sale_date, origins]) => ({ sale_date, ...origins }))
    .sort((a, b) => (a.sale_date as string).localeCompare(b.sale_date as string))

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
          products!inner (id, name, company_id)
        ),
        sales!inner (sale_date, status)
      `)
      .eq('product_variations.products.company_id', companyId)
      .not('sales.status', 'in', '("cancelled","returned")')
      .gte('sales.sale_date', from)
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

  // ── Faturamento por vendedor responsável ─────────────────────────────────
  type SellerSaleRow = {
    responsible_seller_id: number | null
    subtotal: number | null
    discount_amount: number | null
    cashback_used: number | null
  }
  type SellerRow = { id: number; name: string }

  const sellerSaleRows = (sellerSalesRes.data ?? []) as SellerSaleRow[]
  const allSellers     = (sellersRes.data     ?? []) as SellerRow[]

  // Mapa id → name para lookup rápido (inclui inativos como Santtorini)
  const sellerNameById: Record<number, string> = {}
  for (const s of allSellers) sellerNameById[s.id] = s.name

  // Agrega receita líquida: keyed por seller_id numérico (string) ou 'null'
  const sellerRevenueMap: Record<string, number> = {}
  for (const r of sellerSaleRows) {
    const key = r.responsible_seller_id != null ? String(r.responsible_seller_id) : 'null'
    const net =
      Number(r.subtotal        ?? 0) -
      Number(r.discount_amount ?? 0) -
      Number(r.cashback_used   ?? 0)
    sellerRevenueMap[key] = (sellerRevenueMap[key] ?? 0) + net
  }

  // Monta breakdown a partir das entradas do mapa (não da lista de sellers)
  // — garante que vendedores inativos com vendas apareçam
  const sellerBreakdownRaw: SellerStat[] = Object.entries(sellerRevenueMap)
    .filter(([, rev]) => rev > 0)
    .map(([key, rev]) => ({
      sellerId:   key === 'null' ? 0 : Number(key),
      sellerName: key === 'null'
        ? 'Sem vendedor'
        : (sellerNameById[Number(key)] ?? `Vendedor #${key}`),
      revenue: rev,
      pct:     0,
    }))
    .sort((a, b) => b.revenue - a.revenue)

  const totalSellerRevenue = sellerBreakdownRaw.reduce((sum, s) => sum + s.revenue, 0)
  const sellerBreakdown: SellerStat[] = sellerBreakdownRaw.map((s) => ({
    ...s,
    pct: totalSellerRevenue > 0 ? (s.revenue / totalSellerRevenue) * 100 : 0,
  }))

  // ── Montar resposta ───────────────────────────────────────────────────────
  return {
    today: {
      revenue: todayRevenue,
      orders:  todayOrders,
    },
    period: {
      revenue: periodRevenue,
      orders:  periodOrders,
      avgTicket,
      grossMarginPct,
    },
    dailySeries,
    originBreakdown,
    dailyOriginSeries,
    sellerBreakdown,
    topProducts: topProductRows.map(row => ({
      product_id:        row.product_id,
      product_name:      row.product_name,
      total_revenue:     Number(row.total_revenue ?? 0),
      total_units_sold:  Number(row.total_units_sold ?? 0),
      realized_margin_pct: row.realized_margin_pct != null ? Number(row.realized_margin_pct) : null,
    })),
    stockAlerts: ((stockAlertsRes.data ?? []) as any[]).map(row => ({
      product_id:          row.product_id,
      product_name:        row.product_name,
      current_qty:         Number(row.current_qty ?? 0),
      stock_value_at_price: Number(row.stock_value_at_price ?? 0),
    })),
    dateRange: { from, to },
  }
}
