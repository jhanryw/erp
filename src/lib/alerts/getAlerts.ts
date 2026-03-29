import { createAdminClient } from '@/lib/supabase/admin'

export type Alert = {
  type: 'produto' | 'cliente' | 'margem' | 'faturamento'
  severity: 'low' | 'medium' | 'high'
  message: string
}

type SaleItem = {
  quantity: number
  gross_profit: number
  product_variation_id: number
  product_variations: {
    products: { id: number; name: string } | null
  } | null
  sales: { status: string } | null
}

type ClientSale = {
  total: number
  customer_id: number
  customers: { id: number; name: string } | null
  sale_items: { gross_profit: number }[]
}

type MonthRow = {
  month: string
  total_income: number | null
  net_result: number | null
}

function ymBounds(ym: string): { start: string; end: string } {
  const [y, m] = ym.split('-').map(Number)
  const lastDay = new Date(y, m, 0).getDate()
  return {
    start: `${ym}-01`,
    end: `${ym}-${String(lastDay).padStart(2, '0')}`,
  }
}

function currentYM(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function prevYM(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, m - 2, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export async function getAlerts(): Promise<Alert[]> {
  const admin = createAdminClient()
  const alerts: Alert[] = []

  const ym = currentYM()
  const prev = prevYM(ym)
  const { start: currStart, end: currEnd } = ymBounds(ym)
  const { start: prevStart, end: prevEnd } = ymBounds(prev)

  const [rankingRes, clientRes, currSalesRes, prevSalesRes] = await Promise.all([
    // Alerta 1 — produto com prejuízo
    admin
      .from('sale_items')
      .select(`
        quantity,
        gross_profit,
        product_variation_id,
        product_variations:product_variation_id (
          products:product_id (id, name)
        ),
        sales!inner(status)
      `)
      .not('sales.status', 'eq', 'cancelled')
      .not('sales.status', 'eq', 'returned') as unknown as {
        data: SaleItem[] | null
        error: { message: string } | null
      },

    // Alerta 2 — cliente com prejuízo
    admin
      .from('sales')
      .select(`
        total,
        customer_id,
        customers:customer_id (id, name),
        sale_items (gross_profit)
      `)
      .not('status', 'eq', 'cancelled')
      .not('status', 'eq', 'returned') as unknown as {
        data: ClientSale[] | null
        error: { message: string } | null
      },

    // Alerta 3 — margem geral (mês atual)
    admin
      .from('sales')
      .select('total, sale_items(gross_profit)')
      .gte('sale_date', currStart)
      .lte('sale_date', currEnd)
      .not('status', 'eq', 'cancelled')
      .not('status', 'eq', 'returned') as unknown as {
        data: { total: number; sale_items: { gross_profit: number }[] }[] | null
        error: { message: string } | null
      },

    // Alerta 4 — queda de faturamento (mês anterior)
    admin
      .from('sales')
      .select('total')
      .gte('sale_date', prevStart)
      .lte('sale_date', prevEnd)
      .not('status', 'eq', 'cancelled')
      .not('status', 'eq', 'returned') as unknown as {
        data: { total: number }[] | null
        error: { message: string } | null
      },
  ])

  // — Alerta 1: produto com prejuízo
  const productBuckets = new Map<number, { name: string; totalProfit: number }>()
  for (const item of rankingRes.data ?? []) {
    const product = item.product_variations?.products
    const productId = product?.id ?? item.product_variation_id
    const productName = product?.name ?? `Produto ${productId}`
    if (!productBuckets.has(productId)) {
      productBuckets.set(productId, { name: productName, totalProfit: 0 })
    }
    productBuckets.get(productId)!.totalProfit += Number(item.gross_profit)
  }
  for (const [, p] of productBuckets) {
    if (p.totalProfit < 0) {
      alerts.push({
        type: 'produto',
        severity: 'high',
        message: `Produto "${p.name}" está dando prejuízo (${p.totalProfit < -1000 ? 'acima de R$1.000' : 'pequeno'})`,
      })
    }
  }

  // — Alerta 2: cliente com prejuízo
  const clientBuckets = new Map<number, { name: string; totalProfit: number }>()
  for (const sale of clientRes.data ?? []) {
    const customer = sale.customers
    const customerId = customer?.id ?? sale.customer_id
    const customerName = customer?.name ?? `Cliente ${customerId}`
    if (!clientBuckets.has(customerId)) {
      clientBuckets.set(customerId, { name: customerName, totalProfit: 0 })
    }
    for (const item of sale.sale_items ?? []) {
      clientBuckets.get(customerId)!.totalProfit += Number(item.gross_profit)
    }
  }
  for (const [, c] of clientBuckets) {
    if (c.totalProfit < 0) {
      alerts.push({
        type: 'cliente',
        severity: 'medium',
        message: `Cliente "${c.name}" está gerando prejuízo`,
      })
    }
  }

  // — Alerta 3: margem geral do mês abaixo de 20%
  let currRevenue = 0
  let currProfit = 0
  for (const sale of currSalesRes.data ?? []) {
    currRevenue += Number(sale.total)
    for (const item of sale.sale_items ?? []) {
      currProfit += Number(item.gross_profit)
    }
  }
  if (currRevenue > 0) {
    const margin = (currProfit / currRevenue) * 100
    if (margin < 20) {
      const severity = margin < 10 ? 'high' : 'medium'
      alerts.push({
        type: 'margem',
        severity,
        message: `Margem do mês está abaixo de 20% (atual: ${margin.toFixed(1)}%)`,
      })
    }
  }

  // — Alerta 4: queda de faturamento > 20%
  let prevRevenue = 0
  for (const sale of prevSalesRes.data ?? []) {
    prevRevenue += Number(sale.total)
  }
  if (prevRevenue > 0 && currRevenue < prevRevenue) {
    const drop = ((prevRevenue - currRevenue) / prevRevenue) * 100
    if (drop > 20) {
      const severity = drop > 50 ? 'high' : 'medium'
      alerts.push({
        type: 'faturamento',
        severity,
        message: `Faturamento caiu mais de 20% em relação ao mês anterior (queda de ${drop.toFixed(1)}%)`,
      })
    }
  }

  return alerts
}
