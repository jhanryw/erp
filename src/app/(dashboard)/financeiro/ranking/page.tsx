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

type RawItem = {
  quantity: number
  gross_profit: number
  product_variation_id: number
  product_variations: {
    products: { id: number; name: string } | null
  } | null
  sales: { status: string } | null
}

type ProductBucket = {
  productId: number
  productName: string
  totalQuantity: number
  totalProfit: number
}

async function getRankingData() {
  const admin = createAdminClient()

  const { data, error } = await admin
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
    .not('sales.status', 'eq', 'returned') as unknown as { data: RawItem[] | null; error: { message: string } | null }

  if (error) {
    console.error('Erro ao buscar ranking de produtos:', error.message)
    return []
  }

  const buckets = new Map<number, ProductBucket>()

  for (const item of data ?? []) {
    const product = item.product_variations?.products
    const productId = product?.id ?? item.product_variation_id
    const productName = product?.name ?? `Produto ${productId}`

    if (!buckets.has(productId)) {
      buckets.set(productId, { productId, productName, totalQuantity: 0, totalProfit: 0 })
    }

    const b = buckets.get(productId)!
    b.totalQuantity += Number(item.quantity)
    b.totalProfit += Number(item.gross_profit)
  }

  return Array.from(buckets.values())
    .map((b) => ({
      ...b,
      profitPerUnit: b.totalQuantity > 0 ? b.totalProfit / b.totalQuantity : 0,
    }))
    .sort((a, b) => b.totalProfit - a.totalProfit)
}

export default async function RankingPage() {
  const rows = await getRankingData()

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/financeiro">
          <button className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Ranking de Produtos</h2>
          <p className="text-sm text-text-muted">Por lucro total — vendas ativas</p>
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
              <p className="text-xs text-text-muted">{rows.length} produto{rows.length !== 1 ? 's' : ''}</p>
            </CardHeader>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Produto</TableHead>
                    <TableHead align="right">Qtd Vendida</TableHead>
                    <TableHead align="right">Lucro Total</TableHead>
                    <TableHead align="right">Lucro / Unidade</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, idx) => (
                    <TableRow key={row.productId}>
                      <TableCell muted>{idx + 1}</TableCell>
                      <TableCell className="font-medium">{row.productName}</TableCell>
                      <TableCell align="right">{row.totalQuantity}</TableCell>
                      <TableCell
                        align="right"
                        className={`font-semibold ${row.totalProfit >= 0 ? 'text-success' : 'text-error'}`}
                      >
                        {formatCurrency(row.totalProfit)}
                      </TableCell>
                      <TableCell
                        align="right"
                        className={row.profitPerUnit >= 0 ? 'text-text-secondary' : 'text-error'}
                      >
                        {formatCurrency(row.profitPerUnit)}
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
