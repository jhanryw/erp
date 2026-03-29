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

export const dynamic = 'force-dynamic'

type SaleItem = {
  quantity: number
  unit_cost: number
  gross_profit: number
}

type RawSale = {
  id: number
  total: number
  status: string
  customer_id: number
  customers: { id: number; name: string } | null
  sale_items: SaleItem[]
}

type CustomerBucket = {
  customerId: number
  customerName: string
  totalRevenue: number
  totalCost: number
  totalProfit: number
}

async function getClientData() {
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('sales')
    .select(`
      id,
      total,
      status,
      customer_id,
      customers:customer_id (id, name),
      sale_items (
        quantity,
        unit_cost,
        gross_profit
      )
    `)
    .not('status', 'eq', 'cancelled')
    .not('status', 'eq', 'returned') as unknown as {
      data: RawSale[] | null
      error: { message: string } | null
    }

  if (error) {
    console.error('Erro ao buscar lucro por cliente:', error.message)
    return []
  }

  const buckets = new Map<number, CustomerBucket>()

  for (const sale of data ?? []) {
    const customer = sale.customers
    const customerId = customer?.id ?? sale.customer_id
    const customerName = customer?.name ?? `Cliente ${customerId}`

    if (!buckets.has(customerId)) {
      buckets.set(customerId, { customerId, customerName, totalRevenue: 0, totalCost: 0, totalProfit: 0 })
    }

    const b = buckets.get(customerId)!
    b.totalRevenue += Number(sale.total)

    for (const item of sale.sale_items ?? []) {
      b.totalCost += Number(item.unit_cost) * Number(item.quantity)
      b.totalProfit += Number(item.gross_profit)
    }
  }

  return Array.from(buckets.values())
    .map((b) => ({
      ...b,
      margin: b.totalRevenue > 0 ? (b.totalProfit / b.totalRevenue) * 100 : 0,
    }))
    .sort((a, b) => b.totalProfit - a.totalProfit)
}

export default async function LucroPorClientePage() {
  const rows = await getClientData()

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/financeiro">
          <button className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Lucro por Cliente</h2>
          <p className="text-sm text-text-muted">Vendas ativas — ordenado por lucro total</p>
        </div>
      </div>

      <Card>
        {rows.length === 0 ? (
          <div className="py-12 text-center text-sm text-text-muted">
            Nenhum dado disponível.
          </div>
        ) : (
          <>
            <CardHeader>
              <p className="text-xs text-text-muted">{rows.length} cliente{rows.length !== 1 ? 's' : ''}</p>
            </CardHeader>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead align="right">Receita Total</TableHead>
                    <TableHead align="right">Custo Total</TableHead>
                    <TableHead align="right">Lucro Total</TableHead>
                    <TableHead align="right">Margem</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, idx) => (
                    <TableRow key={row.customerId}>
                      <TableCell muted>{idx + 1}</TableCell>
                      <TableCell>
                        <Link
                          href={`/clientes/${row.customerId}`}
                          className="font-medium hover:underline"
                        >
                          {row.customerName}
                        </Link>
                      </TableCell>
                      <TableCell align="right">{formatCurrency(row.totalRevenue)}</TableCell>
                      <TableCell align="right" muted>{formatCurrency(row.totalCost)}</TableCell>
                      <TableCell
                        align="right"
                        className={`font-semibold ${row.totalProfit >= 0 ? 'text-success' : 'text-error'}`}
                      >
                        {formatCurrency(row.totalProfit)}
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
