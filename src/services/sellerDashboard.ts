import { createAdminClient } from '@/lib/supabase/admin'
import { brazilDate, brazilSubDays } from '@/lib/utils/date'
import { ORIGIN_LABELS } from '@/lib/constants/origins'

const PAYMENT_LABELS: Record<string, string> = {
  pix:         'PIX',
  card:        'Cartão',
  cash:        'Dinheiro',
  credit_card: 'Crédito',
  debit_card:  'Débito',
  cashback:    'Crédito de Troca',
}

export interface SellerToday {
  revenue:          number
  orders:           number
  avgTicket:        number
  discounts:        number
  customers:        number
  topPaymentMethod: string | null
  topOrigin:        string | null
}

export interface SellerPeriod {
  revenue:   number
  orders:    number
  avgTicket: number
  discounts: number
  customers: number
}

export interface SellerTopProduct {
  product_id:    number
  product_name:  string
  total_units:   number
  total_revenue: number
}

export interface SellerDailySeries {
  sale_date:     string
  gross_revenue: number
  total_orders:  number
}

export interface SellerMonthlyGoal {
  target:  number
  current: number
  pct:     number
}

export interface SellerDashboardData {
  sellerId:     number
  sellerName:   string
  today:        SellerToday
  period:       SellerPeriod
  dailySeries:  SellerDailySeries[]
  topProducts:  SellerTopProduct[]
  monthlyGoal:  SellerMonthlyGoal | null
  dateRange:    { from: string; to: string }
}

export async function getSellerDashboardData(
  sellerId:  number,
  sellerName: string,
  companyId: number,
  dateFrom:  string,
  dateTo:    string,
): Promise<SellerDashboardData> {
  const admin = createAdminClient()
  const today = brazilDate()

  const [todayRes, periodRes, goalRes] = await Promise.all([
    admin
      .from('sales')
      .select('id, total, discount_amount, customer_id, payment_method, sale_origin')
      .eq('company_id', companyId)
      .eq('sale_date', today)
      .not('status', 'in', '("cancelled","returned")')
    ,
    admin
      .from('sales')
      .select(`
        id, sale_date, total, discount_amount, customer_id,
        sale_items (
          quantity, total_price,
          product_variations!inner (
            product_id,
            products!inner (id, name)
          )
        )
      `)
      .eq('company_id', companyId)
      .gte('sale_date', dateFrom)
      .lte('sale_date', dateTo)
      .not('status', 'in', '("cancelled","returned")')
      .order('sale_date', { ascending: true })
    ,
    admin
      .from('monthly_sales_goals')
      .select('goal_target')
      .eq('company_id', companyId)
      .eq('year',  parseInt(today.substring(0, 4)))
      .eq('month', parseInt(today.substring(5, 7)))
      .maybeSingle()
    ,
  ])

  // ── Hoje ─────────────────────────────────────────────────────────────────
  type TodayRow = {
    id: number; total: number; discount_amount: number;
    customer_id: number; payment_method: string; sale_origin: string | null
  }
  const todayRows    = (todayRes.data ?? []) as TodayRow[]
  const todayRevenue = todayRows.reduce((s, r) => s + Number(r.total ?? 0), 0)
  const todayOrders  = todayRows.length
  const todayDiscounts = todayRows.reduce((s, r) => s + Number(r.discount_amount ?? 0), 0)
  const todayCustomers = new Set(todayRows.map(r => r.customer_id).filter(Boolean)).size

  const pmCount: Record<string, number> = {}
  for (const r of todayRows) {
    if (r.payment_method) pmCount[r.payment_method] = (pmCount[r.payment_method] ?? 0) + 1
  }
  const topPaymentRaw = Object.entries(pmCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const topPaymentMethod = topPaymentRaw ? (PAYMENT_LABELS[topPaymentRaw] ?? topPaymentRaw) : null

  const origCount: Record<string, number> = {}
  for (const r of todayRows) {
    if (r.sale_origin) origCount[r.sale_origin] = (origCount[r.sale_origin] ?? 0) + 1
  }
  const topOriginRaw = Object.entries(origCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const topOrigin = topOriginRaw ? (ORIGIN_LABELS[topOriginRaw] ?? topOriginRaw) : null

  // ── Período ───────────────────────────────────────────────────────────────
  const periodRows    = (periodRes.data ?? []) as any[]
  const periodRevenue = periodRows.reduce((s, r) => s + Number(r.total ?? 0), 0)
  const periodOrders  = periodRows.length
  const periodDiscounts = periodRows.reduce((s, r) => s + Number(r.discount_amount ?? 0), 0)
  const periodCustomers = new Set(periodRows.map((r: any) => r.customer_id).filter(Boolean)).size

  // Série diária
  const dailyMap: Record<string, { revenue: number; orders: number }> = {}
  for (const r of periodRows) {
    const d = r.sale_date as string
    if (!dailyMap[d]) dailyMap[d] = { revenue: 0, orders: 0 }
    dailyMap[d].revenue += Number(r.total ?? 0)
    dailyMap[d].orders  += 1
  }
  const dailySeries: SellerDailySeries[] = Object.entries(dailyMap)
    .map(([sale_date, v]) => ({ sale_date, gross_revenue: v.revenue, total_orders: v.orders }))
    .sort((a, b) => a.sale_date.localeCompare(b.sale_date))

  // Top produtos (tabelas base, filtradas por vendedor)
  const productMap: Record<number, { product_id: number; product_name: string; total_units: number; total_revenue: number }> = {}
  for (const row of periodRows) {
    const items = Array.isArray(row.sale_items) ? row.sale_items : []
    for (const item of items) {
      const pv   = item.product_variations as any
      const prod = Array.isArray(pv?.products) ? pv.products[0] : pv?.products
      const pid  = prod?.id ?? pv?.product_id
      const pname = prod?.name ?? 'Produto'
      if (!pid) continue
      if (!productMap[pid]) productMap[pid] = { product_id: pid, product_name: pname, total_units: 0, total_revenue: 0 }
      productMap[pid].total_units   += Number(item.quantity ?? 0)
      productMap[pid].total_revenue += Number(item.total_price ?? 0)
    }
  }
  const topProducts = Object.values(productMap)
    .sort((a, b) => b.total_revenue - a.total_revenue)
    .slice(0, 5)

  // Meta do mês — usa receita acumulada do mês corrente para este vendedor
  const goalRow = goalRes.data as { goal_target: number } | null
  let monthlyGoal: SellerMonthlyGoal | null = null
  if (goalRow?.goal_target) {
    const monthFrom = `${today.substring(0, 7)}-01`
    const { data: monthSales } = await admin
      .from('sales')
      .select('total')
      .eq('company_id', companyId)
      .gte('sale_date', monthFrom)
      .lte('sale_date', today)
      .not('status', 'in', '("cancelled","returned")')

    const monthRevenue = (monthSales ?? []).reduce((s, r: any) => s + Number(r.total ?? 0), 0)
    const target = Number(goalRow.goal_target)
    monthlyGoal = {
      target,
      current: monthRevenue,
      pct: target > 0 ? Math.min(100, (monthRevenue / target) * 100) : 0,
    }
  }

  return {
    sellerId,
    sellerName,
    today: {
      revenue:          todayRevenue,
      orders:           todayOrders,
      avgTicket:        todayOrders > 0 ? todayRevenue / todayOrders : 0,
      discounts:        todayDiscounts,
      customers:        todayCustomers,
      topPaymentMethod,
      topOrigin,
    },
    period: {
      revenue:   periodRevenue,
      orders:    periodOrders,
      avgTicket: periodOrders > 0 ? periodRevenue / periodOrders : 0,
      discounts: periodDiscounts,
      customers: periodCustomers,
    },
    dailySeries,
    topProducts,
    monthlyGoal,
    dateRange: { from: dateFrom, to: dateTo },
  }
}

// ── Relatório admin: dados por vendedor ──────────────────────────────────────

export interface SellerReportRow {
  sellerId:         number | null
  sellerName:       string
  revenue:          number
  orders:           number
  pctOfTotal:       number
  avgTicket:        number
  grossProfit:      number
  grossMarginPct:   number | null
  totalDiscounts:   number
  avgDiscountPct:   number
  cancellations:    number
  returns:          number
  exchanges:        number
  customers:        number
  topProduct:       string | null
  topCategory:      string | null
  topPayment:       string | null
  topOrigin:        string | null
}

export async function getSellerReport(
  companyId: number,
  dateFrom:  string,
  dateTo:    string,
): Promise<{ rows: SellerReportRow[]; totalRevenue: number; totalOrders: number }> {
  const admin = createAdminClient()

  const [sellersRes, allSalesRes] = await Promise.all([
    admin
      .from('sellers')
      .select('id, name')
      .eq('company_id', companyId)
      .eq('active', true)
      .order('name')
    ,
    admin
      .from('sales')
      .select('id, responsible_seller_id, total, discount_amount, payment_method, sale_origin, customer_id, status')
      .eq('company_id', companyId)
      .gte('sale_date', dateFrom)
      .lte('sale_date', dateTo)
    ,
  ])

  const sellers = (sellersRes.data ?? []) as { id: number; name: string }[]
  const allSales = (allSalesRes.data ?? []) as {
    id: number
    responsible_seller_id: number | null
    total: number
    discount_amount: number
    payment_method: string | null
    sale_origin: string | null
    customer_id: number | null
    status: string
  }[]

  // Separa vendas ativas (para revenue, lucro) das canceladas/devolvidas (para contagem)
  const activeSaleIds = allSales
    .filter(s => !['cancelled', 'returned'].includes(s.status))
    .map(s => s.id)

  // Sale items para lucro e top produto/categoria — apenas vendas ativas
  let itemRows: any[] = []
  if (activeSaleIds.length > 0) {
    const { data: items } = await admin
      .from('sale_items')
      .select(`
        sale_id, quantity, total_price, gross_profit,
        product_variations!inner (
          product_id,
          products!inner (
            id, name,
            categories!category_id (name)
          )
        )
      `)
      .in('sale_id', activeSaleIds) as unknown as { data: any[] | null }
    itemRows = items ?? []
  }

  // Exchanges
  let exchangeRows: any[] = []
  if (allSales.length > 0) {
    const { data: ex } = await (admin as any)
      .from('exchanges')
      .select('id, original_sale_id')
      .in('original_sale_id', allSales.map(s => s.id))
      .eq('status', 'completed')
    exchangeRows = ex ?? []
  }

  // Mapeia exchange original_sale_id → responsible_seller_id
  const saleSellerMap: Record<number, number | null> = {}
  for (const s of allSales) saleSellerMap[s.id] = s.responsible_seller_id

  // ── Agrega por vendedor ───────────────────────────────────────────────────
  type SellerAgg = {
    revenue: number; orders: number; grossProfit: number; totalDiscounts: number
    discountedOrders: number; discountSum: number; cancellations: number; returns: number; exchanges: number
    customers: Set<number>; payments: Record<string, number>; origins: Record<string, number>
    products: Record<number, { name: string; revenue: number; units: number }>
    categories: Record<string, number>
  }

  const makeAgg = (): SellerAgg => ({
    revenue: 0, orders: 0, grossProfit: 0, totalDiscounts: 0,
    discountedOrders: 0, discountSum: 0, cancellations: 0, returns: 0, exchanges: 0,
    customers: new Set(), payments: {}, origins: {},
    products: {}, categories: {},
  })

  // key = sellerId (number) or 'none' for null
  const agg: Record<string | number, SellerAgg> = {}
  const getAgg = (key: string | number) => {
    if (!agg[key]) agg[key] = makeAgg()
    return agg[key]
  }

  // Active sales
  for (const s of allSales) {
    const key = s.responsible_seller_id ?? 'none'
    if (['cancelled', 'returned'].includes(s.status)) {
      if (s.status === 'cancelled') getAgg(key).cancellations++
      if (s.status === 'returned')  getAgg(key).returns++
      continue
    }
    const a = getAgg(key)
    a.revenue    += Number(s.total ?? 0)
    a.orders     += 1
    a.totalDiscounts += Number(s.discount_amount ?? 0)
    if (Number(s.discount_amount ?? 0) > 0) {
      a.discountedOrders++
      a.discountSum += (Number(s.discount_amount ?? 0) / Number(s.total ?? 1)) * 100
    }
    if (s.customer_id) a.customers.add(s.customer_id)
    if (s.payment_method) a.payments[s.payment_method] = (a.payments[s.payment_method] ?? 0) + 1
    if (s.sale_origin)   a.origins[s.sale_origin]     = (a.origins[s.sale_origin] ?? 0) + 1
  }

  // Items (gross_profit + top produto/categoria)
  for (const item of itemRows) {
    const saleId = item.sale_id
    const sellerKey = saleSellerMap[saleId] ?? 'none'
    const a = getAgg(sellerKey)
    a.grossProfit += Number(item.gross_profit ?? 0)

    const pv   = item.product_variations as any
    const prod = Array.isArray(pv?.products) ? pv.products[0] : pv?.products
    const pid  = prod?.id ?? pv?.product_id
    const pname = prod?.name ?? 'Produto'
    if (pid) {
      if (!a.products[pid]) a.products[pid] = { name: pname, revenue: 0, units: 0 }
      a.products[pid].revenue += Number(item.total_price ?? 0)
      a.products[pid].units   += Number(item.quantity ?? 0)
    }

    const cat = Array.isArray(prod?.categories) ? prod?.categories[0]?.name : prod?.categories?.name
    if (cat) a.categories[cat] = (a.categories[cat] ?? 0) + 1
  }

  // Exchanges
  for (const ex of exchangeRows) {
    const sellerKey = saleSellerMap[ex.original_sale_id] ?? 'none'
    getAgg(sellerKey).exchanges++
  }

  // ── Monta linhas do relatório ─────────────────────────────────────────────
  const totalRevenue = Object.values(agg).reduce((s, a) => s + a.revenue, 0)
  const totalOrders  = Object.values(agg).reduce((s, a) => s + a.orders, 0)

  const topOf = (map: Record<string, number>): string | null =>
    Object.entries(map).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  const sellerRows: SellerReportRow[] = sellers.map(seller => {
    const a = agg[seller.id] ?? makeAgg()
    const topProdId = Object.entries(a.products).sort((x, y) => y[1].revenue - x[1].revenue)[0]?.[0]
    const topPayRaw = topOf(a.payments)
    const topOrigRaw = topOf(a.origins)
    return {
      sellerId:       seller.id,
      sellerName:     seller.name,
      revenue:        a.revenue,
      orders:         a.orders,
      pctOfTotal:     totalRevenue > 0 ? (a.revenue / totalRevenue) * 100 : 0,
      avgTicket:      a.orders > 0 ? a.revenue / a.orders : 0,
      grossProfit:    a.grossProfit,
      grossMarginPct: a.revenue > 0 ? (a.grossProfit / a.revenue) * 100 : null,
      totalDiscounts: a.totalDiscounts,
      avgDiscountPct: a.discountedOrders > 0 ? a.discountSum / a.discountedOrders : 0,
      cancellations:  a.cancellations,
      returns:        a.returns,
      exchanges:      a.exchanges,
      customers:      a.customers.size,
      topProduct:     topProdId ? a.products[Number(topProdId)]?.name ?? null : null,
      topCategory:    topOf(a.categories),
      topPayment:     topPayRaw ? (PAYMENT_LABELS[topPayRaw] ?? topPayRaw) : null,
      topOrigin:      topOrigRaw ? (ORIGIN_LABELS[topOrigRaw] ?? topOrigRaw) : null,
    }
  })

  // "Sem vendedor" — apenas se houver vendas sem responsible_seller_id
  const noneAgg = agg['none']
  if (noneAgg && (noneAgg.orders > 0 || noneAgg.cancellations > 0 || noneAgg.returns > 0)) {
    const topProdId = Object.entries(noneAgg.products).sort((x, y) => y[1].revenue - x[1].revenue)[0]?.[0]
    const topPayRaw = topOf(noneAgg.payments)
    const topOrigRaw = topOf(noneAgg.origins)
    sellerRows.push({
      sellerId:       null,
      sellerName:     'Sem vendedor',
      revenue:        noneAgg.revenue,
      orders:         noneAgg.orders,
      pctOfTotal:     totalRevenue > 0 ? (noneAgg.revenue / totalRevenue) * 100 : 0,
      avgTicket:      noneAgg.orders > 0 ? noneAgg.revenue / noneAgg.orders : 0,
      grossProfit:    noneAgg.grossProfit,
      grossMarginPct: noneAgg.revenue > 0 ? (noneAgg.grossProfit / noneAgg.revenue) * 100 : null,
      totalDiscounts: noneAgg.totalDiscounts,
      avgDiscountPct: noneAgg.discountedOrders > 0 ? noneAgg.discountSum / noneAgg.discountedOrders : 0,
      cancellations:  noneAgg.cancellations,
      returns:        noneAgg.returns,
      exchanges:      noneAgg.exchanges,
      customers:      noneAgg.customers.size,
      topProduct:     topProdId ? noneAgg.products[Number(topProdId)]?.name ?? null : null,
      topCategory:    topOf(noneAgg.categories),
      topPayment:     topPayRaw ? (PAYMENT_LABELS[topPayRaw] ?? topPayRaw) : null,
      topOrigin:      topOrigRaw ? (ORIGIN_LABELS[topOrigRaw] ?? topOrigRaw) : null,
    })
  }

  return { rows: sellerRows, totalRevenue, totalOrders }
}
