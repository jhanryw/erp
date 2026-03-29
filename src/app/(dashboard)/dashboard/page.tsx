import Link from 'next/link'
import { TrendingUp, TrendingDown, DollarSign, Wallet } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { getAlerts } from '@/lib/alerts/getAlerts'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils/currency'

export const dynamic = 'force-dynamic'

function currentYearMonth(): { start: string; end: string } {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  const ym = `${y}-${String(m).padStart(2, '0')}`
  const lastDay = new Date(y, m, 0).getDate()
  return {
    start: `${ym}-01`,
    end: `${ym}-${String(lastDay).padStart(2, '0')}`,
  }
}

type SaleItem = {
  unit_cost: number
  quantity: number
  gross_profit: number
}

type RawSale = {
  total: number
  sale_items: SaleItem[]
}

type RawCashEntry = {
  type: 'income' | 'expense'
  amount: number
}

type RawRankingItem = {
  quantity: number
  gross_profit: number
  product_variation_id: number
  product_variations: {
    products: { id: number; name: string } | null
  } | null
  sales: { status: string } | null
}

type RawClientSale = {
  total: number
  customer_id: number
  customers: { id: number; name: string } | null
  sale_items: SaleItem[]
}

async function getDashboardData() {
  const admin = createAdminClient()
  const { start, end } = currentYearMonth()

  const [salesRes, cashRes, rankingRes, clientRes, alerts] = await Promise.all([
    // Faturamento + lucro do mês
    admin
      .from('sales')
      .select('total, sale_items(unit_cost, quantity, gross_profit)')
      .gte('sale_date', start)
      .lte('sale_date', end)
      .not('status', 'eq', 'cancelled')
      .not('status', 'eq', 'returned') as unknown as {
        data: RawSale[] | null
        error: { message: string } | null
      },

    // Fluxo de caixa do mês
    admin
      .from('finance_entries')
      .select('type, amount')
      .gte('reference_date', start)
      .lte('reference_date', end) as unknown as {
        data: RawCashEntry[] | null
        error: { message: string } | null
      },

    // Ranking de produtos (todos — filter after)
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
        data: RawRankingItem[] | null
        error: { message: string } | null
      },

    // Lucro por cliente (todos — filter after)
    admin
      .from('sales')
      .select(`
        total,
        customer_id,
        customers:customer_id (id, name),
        sale_items (quantity, unit_cost, gross_profit)
      `)
      .not('status', 'eq', 'cancelled')
      .not('status', 'eq', 'returned') as unknown as {
        data: RawClientSale[] | null
        error: { message: string } | null
      },

    // Alertas inteligentes
    getAlerts(),
  ])

  // — Financial KPIs
  let faturamento = 0
  let custo = 0
  let lucro = 0

  for (const sale of salesRes.data ?? []) {
    faturamento += Number(sale.total)
    for (const item of sale.sale_items ?? []) {
      custo += Number(item.unit_cost) * Number(item.quantity)
      lucro += Number(item.gross_profit)
    }
  }
  const margem = faturamento > 0 ? (lucro / faturamento) * 100 : 0

  // — Cash flow KPIs
  let entradas = 0
  let saidas = 0
  for (const e of cashRes.data ?? []) {
    if (e.type === 'income') entradas += Number(e.amount)
    else saidas += Number(e.amount)
  }
  const saldo = entradas - saidas

  // — Top 5 products
  const productBuckets = new Map<number, { productId: number; productName: string; totalQuantity: number; totalProfit: number }>()
  for (const item of rankingRes.data ?? []) {
    const product = item.product_variations?.products
    const productId = product?.id ?? item.product_variation_id
    const productName = product?.name ?? `Produto ${productId}`
    if (!productBuckets.has(productId)) {
      productBuckets.set(productId, { productId, productName, totalQuantity: 0, totalProfit: 0 })
    }
    const b = productBuckets.get(productId)!
    b.totalQuantity += Number(item.quantity)
    b.totalProfit += Number(item.gross_profit)
  }
  const topProducts = Array.from(productBuckets.values())
    .sort((a, b) => b.totalProfit - a.totalProfit)
    .slice(0, 5)

  // — Top 5 clients
  const clientBuckets = new Map<number, { customerId: number; customerName: string; totalRevenue: number; totalProfit: number }>()
  for (const sale of clientRes.data ?? []) {
    const customer = sale.customers
    const customerId = customer?.id ?? sale.customer_id
    const customerName = customer?.name ?? `Cliente ${customerId}`
    if (!clientBuckets.has(customerId)) {
      clientBuckets.set(customerId, { customerId, customerName, totalRevenue: 0, totalProfit: 0 })
    }
    const b = clientBuckets.get(customerId)!
    b.totalRevenue += Number(sale.total)
    for (const item of sale.sale_items ?? []) {
      b.totalProfit += Number(item.gross_profit)
    }
  }
  const topClients = Array.from(clientBuckets.values())
    .sort((a, b) => b.totalProfit - a.totalProfit)
    .slice(0, 5)

  return { faturamento, custo, lucro, margem, entradas, saidas, saldo, topProducts, topClients, alerts }
}

export default async function DashboardPage() {
  const {
    faturamento,
    lucro,
    margem,
    entradas,
    saidas,
    saldo,
    topProducts,
    topClients,
    alerts,
  } = await getDashboardData()

  alerts.sort((a, b) => {
    const priority = { high: 2, medium: 1, low: 0 }
    return priority[b.severity] - priority[a.severity]
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard Executivo</h1>
        <p className="text-sm text-muted-foreground">Mês atual — dados consolidados</p>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-text-muted">Faturamento</p>
            <TrendingUp className="h-4 w-4 text-text-muted" />
          </div>
          <p className="text-2xl font-bold text-text-primary">{formatCurrency(faturamento)}</p>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-text-muted">Lucro Bruto</p>
            <DollarSign className="h-4 w-4 text-text-muted" />
          </div>
          <p className={`text-2xl font-bold ${lucro >= 0 ? 'text-success' : 'text-error'}`}>
            {formatCurrency(lucro)}
          </p>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-text-muted">Margem Bruta</p>
            {margem >= 0 ? (
              <TrendingUp className="h-4 w-4 text-text-muted" />
            ) : (
              <TrendingDown className="h-4 w-4 text-text-muted" />
            )}
          </div>
          <p className={`text-2xl font-bold ${margem >= 0 ? 'text-success' : 'text-error'}`}>
            {margem.toFixed(1)}%
          </p>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-text-muted">Saldo de Caixa</p>
            <Wallet className="h-4 w-4 text-text-muted" />
          </div>
          <p className={`text-2xl font-bold ${saldo >= 0 ? 'text-success' : 'text-error'}`}>
            {formatCurrency(saldo)}
          </p>
          <p className="text-xs text-text-muted mt-1">
            {formatCurrency(entradas)} in · {formatCurrency(saidas)} out
          </p>
        </div>
      </div>

      {/* Alertas */}
      {alerts.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">
            ⚠️ Atenção necessária ({alerts.length})
          </h2>

          {alerts.map((alert, index) => {
            const currentMonth = (() => {
              const now = new Date()
              return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
            })()
            const href =
              alert.type === 'produto'    ? '/financeiro/ranking' :
              alert.type === 'cliente'    ? '/financeiro/clientes' :
              alert.type === 'margem'     ? `/financeiro/dre?month=${currentMonth}` :
              alert.type === 'faturamento'? `/financeiro/fluxo?month=${currentMonth}` :
              '#'

            return (
              <Link key={index} href={href} className="block">
                <div
                  className={`p-4 rounded-lg border-2 transition-opacity hover:opacity-80 ${
                    alert.severity === 'high'
                      ? 'border-red-500 bg-red-50'
                      : 'border-yellow-400 bg-yellow-50'
                  }`}
                >
                  <p
                    className={`text-sm font-medium ${
                      alert.severity === 'high'
                        ? 'text-red-700'
                        : 'text-yellow-700'
                    }`}
                  >
                    {alert.severity === 'high' ? '🔴' : '🟡'} {alert.message}
                  </p>
                </div>
              </Link>
            )
          })}
        </div>
      )}

      {/* Tables */}
      <div className="grid gap-6 xl:grid-cols-2">
        {/* Top 5 Produtos */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Top 5 Produtos</h2>
              <Link href="/financeiro/ranking" className="text-xs text-text-muted hover:underline">
                Ver todos
              </Link>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {topProducts.length === 0 ? (
              <p className="py-8 text-center text-sm text-text-muted">Sem dados.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Produto</TableHead>
                    <TableHead align="right">Qtd</TableHead>
                    <TableHead align="right">Lucro</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topProducts.map((p, idx) => (
                    <TableRow key={p.productId}>
                      <TableCell muted>{idx + 1}</TableCell>
                      <TableCell className="font-medium">{p.productName}</TableCell>
                      <TableCell align="right" muted>{p.totalQuantity}</TableCell>
                      <TableCell
                        align="right"
                        className={`font-semibold ${p.totalProfit >= 0 ? 'text-success' : 'text-error'}`}
                      >
                        {formatCurrency(p.totalProfit)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Top 5 Clientes */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Top 5 Clientes</h2>
              <Link href="/financeiro/clientes" className="text-xs text-text-muted hover:underline">
                Ver todos
              </Link>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {topClients.length === 0 ? (
              <p className="py-8 text-center text-sm text-text-muted">Sem dados.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead align="right">Receita</TableHead>
                    <TableHead align="right">Lucro</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topClients.map((c, idx) => (
                    <TableRow key={c.customerId}>
                      <TableCell muted>{idx + 1}</TableCell>
                      <TableCell>
                        <Link
                          href={`/clientes/${c.customerId}`}
                          className="font-medium hover:underline"
                        >
                          {c.customerName}
                        </Link>
                      </TableCell>
                      <TableCell align="right" muted>{formatCurrency(c.totalRevenue)}</TableCell>
                      <TableCell
                        align="right"
                        className={`font-semibold ${c.totalProfit >= 0 ? 'text-success' : 'text-error'}`}
                      >
                        {formatCurrency(c.totalProfit)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
