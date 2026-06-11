import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

export const dynamic = 'force-dynamic'

async function getTurnoverData() {
  const supabase = createAdminClient()

  const [stockRes, salesRes] = await Promise.all([
    (supabase as any)
      .from('vw_stock_live')
      .select('product_variation_id, product_id, product_name, sku_parent, sku_variation, cor, tamanho, current_qty, avg_cost, stock_value_at_cost, last_entry_date')
      .order('current_qty', { ascending: false })
      .limit(200) as unknown as Promise<{ data: any[] | null; error: any }>,

    supabase
      .from('sale_items')
      .select('quantity, product_variation_id, product_variations!inner(product_id), sales!inner(sale_date, status)')
      .not('sales.status' as any, 'eq', 'cancelled')
      .not('sales.status' as any, 'eq', 'returned') as unknown as Promise<{
        data: Array<{
          quantity: number
          product_variation_id: number
          product_variations: { product_id: number } | null
          sales: { sale_date: string; status: string } | null
        }> | null
        error: any
      }>,
  ])

  if (stockRes.error) console.error('vw_stock_live error:', stockRes.error.message)

  // Aggregate sold units + last sale date per product_id (all time)
  const perfByProduct = new Map<number, { totalSold: number; lastSaleDate: string | null }>()
  for (const item of salesRes.data ?? []) {
    const productId = item.product_variations?.product_id
    if (!productId) continue
    if (!perfByProduct.has(productId)) {
      perfByProduct.set(productId, { totalSold: 0, lastSaleDate: null })
    }
    const p = perfByProduct.get(productId)!
    p.totalSold += Number(item.quantity)
    const saleDate = item.sales?.sale_date ?? null
    if (saleDate && (!p.lastSaleDate || saleDate > p.lastSaleDate)) {
      p.lastSaleDate = saleDate
    }
  }

  const items = (stockRes.data ?? []).map((s: any) => {
    const perf = perfByProduct.get(s.product_id) ?? { totalSold: 0, lastSaleDate: null }
    const daysSinceEntry = s.last_entry_date
      ? Math.floor((Date.now() - new Date(s.last_entry_date).getTime()) / 86400000)
      : null
    const diasParaVender = perf.totalSold > 0 && daysSinceEntry && daysSinceEntry > 0
      ? Math.round((s.current_qty ?? 0) / (perf.totalSold / daysSinceEntry))
      : null
    const sku = s.sku_variation ?? s.sku_parent ?? '—'
    const variacao = [s.cor, s.tamanho].filter(Boolean).join(' / ') || null

    return {
      ...s,
      totalSold: perf.totalSold,
      last_sale_date: perf.lastSaleDate,
      diasParaVender,
      daysSinceEntry,
      sku,
      variacao,
    }
  })

  return items
}

export default async function GiroEstoquePage() {
  const items = await getTurnoverData()

  const parados = items.filter((i: any) => !i.last_sale_date && (i.current_qty ?? 0) > 0)
  const totalValue = items.reduce((s: number, i: any) => s + (i.stock_value_at_cost ?? 0), 0)
  const paradosValue = parados.reduce((s: number, i: any) => s + (i.stock_value_at_cost ?? 0), 0)

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/inteligencia">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Giro de Estoque</h2>
          <p className="text-sm text-text-muted">Identifique produtos parados e velocidade de venda</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Itens em Estoque', value: items.length, sub: 'variações' },
          { label: 'Valor Total', value: formatCurrency(totalValue), sub: 'a custo' },
          { label: 'Produtos Parados', value: parados.length, sub: 'sem venda registrada', className: parados.length > 0 ? 'text-warning' : 'text-text-primary' },
          { label: 'Capital Imobilizado', value: formatCurrency(paradosValue), sub: 'em produtos parados', className: paradosValue > 0 ? 'text-error' : 'text-text-primary' },
        ].map((kpi) => (
          <div key={kpi.label} className="card p-4">
            <p className="text-xs text-text-muted mb-1">{kpi.label}</p>
            <p className={`text-xl font-bold ${kpi.className ?? 'text-text-primary'}`}>{kpi.value}</p>
            <p className="text-xs text-text-muted mt-0.5">{kpi.sub}</p>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">Análise de Giro por Variação</h3>
        </CardHeader>
        {items.length === 0 ? (
          <div className="p-12 text-center text-sm text-text-muted">Nenhum item em estoque</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produto / Variação</TableHead>
                <TableHead align="right">Em Estoque</TableHead>
                <TableHead align="right">Já Vendido</TableHead>
                <TableHead align="right">Val. Estoque</TableHead>
                <TableHead>Última Venda</TableHead>
                <TableHead align="right">Dias p/ Vender</TableHead>
                <TableHead align="center">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item: any) => {
                const parado = !item.last_sale_date && (item.current_qty ?? 0) > 0
                const zerado = (item.current_qty ?? 0) === 0
                return (
                  <TableRow key={item.product_variation_id}>
                    <TableCell>
                      <Link href={`/produtos/${item.product_id}`} className="font-medium hover:text-accent block">
                        {item.product_name}
                      </Link>
                      <span className="font-mono text-xs text-text-muted">
                        {item.sku}
                        {item.variacao && <span className="ml-1 not-mono">· {item.variacao}</span>}
                      </span>
                    </TableCell>
                    <TableCell align="right" className={zerado ? 'text-error font-bold' : 'font-semibold'}>{item.current_qty ?? 0}</TableCell>
                    <TableCell align="right" muted>{item.totalSold}</TableCell>
                    <TableCell align="right">{formatCurrency(item.stock_value_at_cost ?? 0)}</TableCell>
                    <TableCell muted>{item.last_sale_date ? formatDate(item.last_sale_date) : '—'}</TableCell>
                    <TableCell align="right" muted>
                      {item.diasParaVender != null ? `~${item.diasParaVender}d` : '—'}
                    </TableCell>
                    <TableCell align="center">
                      {zerado ? (
                        <Badge variant="default" size="sm">Zerado</Badge>
                      ) : parado ? (
                        <Badge variant="warning" size="sm">Parado</Badge>
                      ) : item.diasParaVender != null && item.diasParaVender < 30 ? (
                        <Badge variant="success" size="sm">Rápido</Badge>
                      ) : (
                        <Badge variant="info" size="sm">Normal</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  )
}
