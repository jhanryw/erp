import Link from 'next/link'
import { TrendingUp, TrendingDown, DollarSign, Wallet, PackageSearch } from 'lucide-react'

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
import { DashboardCharts } from './charts-section'

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

type RawSaleItem = {
  quantity: number
  sales: { sale_date: string; status: string } | null
}

type RawStockRow = {
  current_qty: number | null
}

type PieData = { name: string; value: number; pct: number }
type CoverageItem = { name: string; dias: number; qty: number }

async function getCicloOperacional(admin: ReturnType<typeof createAdminClient>) {
  const JANELA_DIAS = 60
  const BUFFER_DIAS = 30

  const desde = new Date()
  desde.setDate(desde.getDate() - JANELA_DIAS)
  const desdeStr = desde.toISOString().slice(0, 10)

  const [vendidosRes, estoqueRes] = await Promise.all([
    admin
      .from('sale_items')
      .select('quantity, sales!inner(sale_date, status)')
      .gte('sales.sale_date' as any, desdeStr)
      .not('sales.status' as any, 'eq', 'cancelled')
      .not('sales.status' as any, 'eq', 'returned') as unknown as {
        data: RawSaleItem[] | null
      },
    (admin as any)
      .from('vw_stock_live')
      .select('current_qty') as unknown as {
        data: RawStockRow[] | null
      },
  ])

  const totalVendido = (vendidosRes.data ?? []).reduce(
    (s, r) => s + Number(r.quantity ?? 0), 0
  )
  const estoqueTotal = (estoqueRes.data ?? []).reduce(
    (s, r) => s + Number(r.current_qty ?? 0), 0
  )

  const pecasPorDia    = totalVendido / JANELA_DIAS
  const coberturaDias  = pecasPorDia > 0 ? Math.round(estoqueTotal / pecasPorDia) : null
  const pedirEmDias    = coberturaDias != null ? Math.max(0, coberturaDias - BUFFER_DIAS) : null

  return {
    pecasPorDia:    Math.round(pecasPorDia * 10) / 10,
    totalVendido60: totalVendido,
    estoqueTotal,
    coberturaDias,
    pedirEmDias,
    janelaDias:     JANELA_DIAS,
  }
}

async function getVendasPorAtributo(admin: ReturnType<typeof createAdminClient>): Promise<{ byColor: PieData[]; bySize: PieData[] }> {
  const DIAS = 90
  const desde = new Date()
  desde.setDate(desde.getDate() - DIAS)
  const desdeStr = desde.toISOString().slice(0, 10)

  const { data: varTypes } = await admin
    .from('variation_types' as any)
    .select('id, slug')
    .in('slug', ['cor', 'tamanho']) as unknown as { data: Array<{ id: number; slug: string }> | null }

  const corTypeId = (varTypes ?? []).find(t => t.slug === 'cor')?.id
  const tamanhoTypeId = (varTypes ?? []).find(t => t.slug === 'tamanho')?.id

  const { data: saleItemsRaw } = await (admin
    .from('sale_items')
    .select('product_variation_id, quantity, sales!inner(sale_date, status)')
    .gte('sales.sale_date' as any, desdeStr)
    .not('sales.status' as any, 'eq', 'cancelled')
    .not('sales.status' as any, 'eq', 'returned')) as unknown as {
      data: Array<{ product_variation_id: number; quantity: number }> | null
    }

  const saleItems = saleItemsRaw ?? []
  const soldIds = [...new Set(saleItems.map(s => s.product_variation_id))]

  if (soldIds.length === 0) return { byColor: [], bySize: [] }

  const typeIds = [corTypeId, tamanhoTypeId].filter(Boolean) as number[]
  const { data: attrsRaw } = await (admin
    .from('product_variation_attributes' as any)
    .select('product_variation_id, variation_type_id, variation_values!inner(value)')
    .in('product_variation_id', soldIds)
    .in('variation_type_id', typeIds)) as unknown as {
      data: Array<{
        product_variation_id: number
        variation_type_id: number
        variation_values: { value: string } | null
      }> | null
    }

  const attrMap = new Map<number, { cor?: string; tamanho?: string }>()
  for (const a of attrsRaw ?? []) {
    if (!attrMap.has(a.product_variation_id)) attrMap.set(a.product_variation_id, {})
    const entry = attrMap.get(a.product_variation_id)!
    if (a.variation_type_id === corTypeId) entry.cor = a.variation_values?.value
    if (a.variation_type_id === tamanhoTypeId) entry.tamanho = a.variation_values?.value
  }

  const byColorMap = new Map<string, number>()
  const bySizeMap = new Map<string, number>()

  for (const item of saleItems) {
    const attrs = attrMap.get(item.product_variation_id) ?? {}
    const qty = Number(item.quantity)
    if (attrs.cor) byColorMap.set(attrs.cor, (byColorMap.get(attrs.cor) ?? 0) + qty)
    if (attrs.tamanho) bySizeMap.set(attrs.tamanho, (bySizeMap.get(attrs.tamanho) ?? 0) + qty)
  }

  function toPieData(map: Map<string, number>): PieData[] {
    const total = Array.from(map.values()).reduce((a, b) => a + b, 0)
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, value]) => ({ name, value, pct: total > 0 ? (value / total) * 100 : 0 }))
  }

  return { byColor: toPieData(byColorMap), bySize: toPieData(bySizeMap) }
}

async function getCoverageByProduct(admin: ReturnType<typeof createAdminClient>): Promise<CoverageItem[]> {
  const JANELA_DIAS = 60
  const desde = new Date()
  desde.setDate(desde.getDate() - JANELA_DIAS)
  const desdeStr = desde.toISOString().slice(0, 10)

  const [stockRes, vendidosRes] = await Promise.all([
    (admin as any)
      .from('vw_stock_live')
      .select('product_id, product_name, current_qty') as unknown as Promise<{
        data: Array<{ product_id: number; product_name: string; current_qty: number | null }> | null
      }>,
    (admin
      .from('sale_items')
      .select('quantity, product_variation_id, product_variations(product_id), sales!inner(sale_date, status)')
      .gte('sales.sale_date' as any, desdeStr)
      .not('sales.status' as any, 'eq', 'cancelled')
      .not('sales.status' as any, 'eq', 'returned')) as unknown as Promise<{
        data: Array<{
          quantity: number
          product_variation_id: number
          product_variations: { product_id: number } | null
        }> | null
      }>,
  ])

  const stockByProduct = new Map<number, { name: string; qty: number }>()
  for (const row of stockRes.data ?? []) {
    if (!stockByProduct.has(row.product_id)) {
      stockByProduct.set(row.product_id, { name: row.product_name, qty: 0 })
    }
    stockByProduct.get(row.product_id)!.qty += Number(row.current_qty ?? 0)
  }

  const soldByProduct = new Map<number, number>()
  for (const item of vendidosRes.data ?? []) {
    const productId = item.product_variations?.product_id
    if (!productId) continue
    soldByProduct.set(productId, (soldByProduct.get(productId) ?? 0) + Number(item.quantity))
  }

  return Array.from(stockByProduct.entries())
    .filter(([, s]) => s.qty > 0)
    .map(([productId, s]) => {
      const totalSold = soldByProduct.get(productId) ?? 0
      const pecasPorDia = totalSold / JANELA_DIAS
      const dias = pecasPorDia > 0 ? Math.round(s.qty / pecasPorDia) : 999
      return { name: s.name, dias, qty: s.qty }
    })
    .sort((a, b) => a.dias - b.dias)
    .slice(0, 8)
}

async function getDashboardData() {
  const admin = createAdminClient()
  const { start, end } = currentYearMonth()

  const [salesRes, cashRes, rankingRes, clientRes, alerts, ciclo, vendasAtributos, coverage] = await Promise.all([
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
    // Ciclo operacional
    getCicloOperacional(admin),
    // Gráficos de vendas por cor e tamanho
    getVendasPorAtributo(admin),
    // Cobertura de estoque por produto
    getCoverageByProduct(admin),
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

  return {
    faturamento, custo, lucro, margem, entradas, saidas, saldo,
    topProducts, topClients, alerts, ciclo,
    byColor: vendasAtributos.byColor,
    bySize: vendasAtributos.bySize,
    coverage,
  }
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
    ciclo,
    byColor,
    bySize,
    coverage,
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

      {/* Ciclo Operacional */}
      {(() => {
        const { coberturaDias, pecasPorDia, estoqueTotal, totalVendido60, pedirEmDias, janelaDias } = ciclo
        const semDados = pecasPorDia === 0
        const urgente  = coberturaDias != null && coberturaDias < 15
        const atencao  = coberturaDias != null && coberturaDias < 30
        const cor = urgente ? 'text-error' : atencao ? 'text-warning' : 'text-success'
        const bgCor = urgente ? 'bg-error/8 border-error/30' : atencao ? 'bg-warning/8 border-warning/30' : 'bg-success/8 border-success/30'
        const label = urgente ? 'Reposição urgente' : atencao ? 'Planejar compra em breve' : 'Estoque confortável'

        return (
          <div className={`rounded-xl border p-4 ${bgCor}`}>
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-2">
                <PackageSearch className="w-5 h-5 text-text-muted shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-text-primary">Ciclo Operacional</p>
                  <p className="text-xs text-text-muted">Baseado nas vendas dos últimos {janelaDias} dias</p>
                </div>
              </div>
              {!semDados && (
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${cor} bg-current/10`}>
                  {label}
                </span>
              )}
            </div>

            {semDados ? (
              <p className="mt-3 text-sm text-text-muted">
                Sem vendas nos últimos {janelaDias} dias — registre vendas para calcular o ciclo.
              </p>
            ) : (
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-text-muted mb-1">Cobertura de estoque</p>
                  <p className={`text-2xl font-bold tabular-nums ${cor}`}>
                    {coberturaDias != null ? `${coberturaDias}d` : '—'}
                  </p>
                  <p className="text-[11px] text-text-muted">dias no ritmo atual</p>
                </div>

                <div>
                  <p className="text-xs text-text-muted mb-1">Velocidade de venda</p>
                  <p className="text-2xl font-bold tabular-nums text-text-primary">
                    {pecasPorDia.toFixed(1)}
                  </p>
                  <p className="text-[11px] text-text-muted">peças por dia</p>
                </div>

                <div>
                  <p className="text-xs text-text-muted mb-1">Estoque atual</p>
                  <p className="text-2xl font-bold tabular-nums text-text-primary">
                    {estoqueTotal}
                  </p>
                  <p className="text-[11px] text-text-muted">peças em estoque</p>
                </div>

                <div>
                  <p className="text-xs text-text-muted mb-1">Próximo pedido</p>
                  <p className={`text-2xl font-bold tabular-nums ${pedirEmDias === 0 ? 'text-error' : 'text-text-primary'}`}>
                    {pedirEmDias === 0 ? 'Agora' : pedirEmDias != null ? `em ${pedirEmDias}d` : '—'}
                  </p>
                  <p className="text-[11px] text-text-muted">
                    {pedirEmDias === 0
                      ? `${totalVendido60} vendidas em ${janelaDias}d`
                      : `para manter 30d de reserva`}
                  </p>
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* Gráficos: Vendas por Cor, Tamanho e Cobertura por Produto */}
      <DashboardCharts byColor={byColor} bySize={bySize} coverageItems={coverage} />

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
