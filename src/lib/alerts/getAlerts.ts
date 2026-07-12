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

/**
 * companyId é opcional por um motivo específico: /api/alerts/daily (cron de
 * WhatsApp, sem sessão de usuário) chama getAlerts() sem nenhum company_id
 * disponível — não há uma resposta óbvia de onde esse job deveria obtê-lo, e
 * isso está fora do escopo aprovado da Entrega Financeiro 1.2 (que só cobre
 * chamadores com sessão via requirePageRole). Quando companyId não é
 * informado, o comportamento é idêntico ao de antes desta entrega (sem
 * filtro) — nenhuma regressão para essa rota, mas ela continua com o mesmo
 * risco de mistura entre empresas que já tinha. Fica registrado como
 * pendência para uma entrega futura decidir como o cron resolve company_id.
 */
export async function getAlerts(companyId?: number): Promise<Alert[]> {
  const admin = createAdminClient()
  const alerts: Alert[] = []

  const ym = currentYM()
  const prev = prevYM(ym)
  const { start: currStart, end: currEnd } = ymBounds(ym)
  const { start: prevStart, end: prevEnd } = ymBounds(prev)

  // Alerta 1 — produto com prejuízo. sale_items não tem company_id próprio —
  // isolado via sales.company_id (join !inner) quando companyId é informado.
  let rankingQuery = admin
    .from('sale_items')
    .select(`
      quantity,
      gross_profit,
      product_variation_id,
      product_variations:product_variation_id (
        products:product_id (id, name)
      ),
      sales!inner(status, company_id)
    `)
  if (companyId != null) rankingQuery = rankingQuery.eq('sales.company_id' as any, companyId)
  rankingQuery = rankingQuery
    .not('sales.status', 'eq', 'cancelled')
    .not('sales.status', 'eq', 'returned')

  // Alerta 2 — cliente com prejuízo
  let clientQuery = admin
    .from('sales')
    .select(`
      total,
      customer_id,
      customers:customer_id (id, name),
      sale_items (gross_profit)
    `)
  if (companyId != null) clientQuery = clientQuery.eq('company_id', companyId)
  clientQuery = clientQuery
    .not('status', 'eq', 'cancelled')
    .not('status', 'eq', 'returned')

  // Alerta 3 — margem geral (mês atual)
  let currSalesQuery = admin
    .from('sales')
    .select('total, sale_items(gross_profit)')
  if (companyId != null) currSalesQuery = currSalesQuery.eq('company_id', companyId)
  currSalesQuery = currSalesQuery
    .gte('sale_date', currStart)
    .lte('sale_date', currEnd)
    .not('status', 'eq', 'cancelled')
    .not('status', 'eq', 'returned')

  // Alerta 4 — queda de faturamento (mês anterior)
  let prevSalesQuery = admin
    .from('sales')
    .select('total')
  if (companyId != null) prevSalesQuery = prevSalesQuery.eq('company_id', companyId)
  prevSalesQuery = prevSalesQuery
    .gte('sale_date', prevStart)
    .lte('sale_date', prevEnd)
    .not('status', 'eq', 'cancelled')
    .not('status', 'eq', 'returned')

  const [rankingRes, clientRes, currSalesRes, prevSalesRes] = await Promise.all([
    rankingQuery as unknown as {
      data: SaleItem[] | null
      error: { message: string } | null
    },
    clientQuery as unknown as {
      data: ClientSale[] | null
      error: { message: string } | null
    },
    currSalesQuery as unknown as {
      data: { total: number; sale_items: { gross_profit: number }[] }[] | null
      error: { message: string } | null
    },
    prevSalesQuery as unknown as {
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
