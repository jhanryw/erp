import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { Card, CardHeader } from '@/components/ui/card'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

export const dynamic = 'force-dynamic'

type SaleItem = {
  unit_cost: number
  quantity: number
  gross_profit: number
}

type SaleRow = {
  id: number
  sale_number: string
  sale_date: string
  total: number
  status: string
  customers: { name: string } | null
  sale_items: SaleItem[]
}

async function getProfitData() {
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('sales')
    .select(`
      id,
      sale_number,
      sale_date,
      total,
      status,
      customers:customer_id (name),
      sale_items (
        unit_cost,
        quantity,
        gross_profit
      )
    `)
    .not('status', 'eq', 'cancelled')
    .order('sale_date', { ascending: false })
    .limit(100) as unknown as { data: SaleRow[] | null; error: { message: string } | null }

  if (error) {
    console.error('Erro ao buscar lucro por venda:', error.message)
    return []
  }

  return (data ?? []).map((sale) => {
    const items = sale.sale_items ?? []
    const revenue = Number(sale.total)
    const totalCost = items.reduce((s, i) => s + Number(i.unit_cost) * Number(i.quantity), 0)
    const grossProfit = items.reduce((s, i) => s + Number(i.gross_profit), 0)
    const margin = revenue > 0 ? (grossProfit / revenue) * 100 : 0

    return {
      id: sale.id,
      sale_number: sale.sale_number,
      sale_date: sale.sale_date,
      status: sale.status,
      customerName: sale.customers?.name ?? '—',
      revenue,
      totalCost,
      grossProfit,
      margin,
    }
  })
}

export default async function LucroPage() {
  const rows = await getProfitData()

  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0)
  const totalCost = rows.reduce((s, r) => s + r.totalCost, 0)
  const totalProfit = rows.reduce((s, r) => s + r.grossProfit, 0)
  const overallMargin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/financeiro">
          <button className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Lucro por Venda</h2>
          <p className="text-sm text-text-muted">Últimas 100 vendas não canceladas</p>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Receita Total</p>
          <p className="text-xl font-bold text-text-primary">{formatCurrency(totalRevenue)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Custo Total</p>
          <p className="text-xl font-bold text-text-primary">{formatCurrency(totalCost)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Lucro Total</p>
          <p className={`text-xl font-bold ${totalProfit >= 0 ? 'text-success' : 'text-error'}`}>
            {formatCurrency(totalProfit)}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Margem Média</p>
          <p className={`text-xl font-bold ${overallMargin >= 0 ? 'text-success' : 'text-error'}`}>
            {overallMargin.toFixed(2)}%
          </p>
        </div>
      </div>

      <Card>
        {rows.length === 0 ? (
          <div className="py-12 text-center text-sm text-text-muted">
            Nenhuma venda encontrada.
          </div>
        ) : (
          <>
            <CardHeader>
              <p className="text-xs text-text-muted">{rows.length} vendas</p>
            </CardHeader>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Venda</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead>Data</TableHead>
                    <TableHead align="right">Receita</TableHead>
                    <TableHead align="right">Custo</TableHead>
                    <TableHead align="right">Lucro</TableHead>
                    <TableHead align="right">Margem</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Link
                          href={`/vendas/${row.id}`}
                          className="font-mono text-sm hover:underline"
                        >
                          {row.sale_number}
                        </Link>
                      </TableCell>
                      <TableCell muted>{row.customerName}</TableCell>
                      <TableCell muted>{formatDate(row.sale_date)}</TableCell>
                      <TableCell align="right">{formatCurrency(row.revenue)}</TableCell>
                      <TableCell align="right" muted>{formatCurrency(row.totalCost)}</TableCell>
                      <TableCell
                        align="right"
                        className={`font-semibold ${row.grossProfit >= 0 ? 'text-success' : 'text-error'}`}
                      >
                        {formatCurrency(row.grossProfit)}
                      </TableCell>
                      <TableCell
                        align="right"
                        className={`font-semibold ${row.margin >= 0 ? 'text-success' : 'text-error'}`}
                      >
                        {row.margin.toFixed(2)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
