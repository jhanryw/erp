import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { Plus, ShoppingCart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SaleStatusBadge } from '@/components/ui/badge'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import type { SaleStatus } from '@/types/database.types'

async function getSales() {
  const supabase = createClient()
  const { data } = await supabase
    .from('sales')
    .select(`
      id, sale_number, total, discount_amount, cashback_used,
      payment_method, status, sale_date, created_at,
      customers:customer_id (id, name, cpf),
      users:seller_id (id, name)
    `)
    .order('created_at', { ascending: false })
    .limit(50) as unknown as { data: any[] | null, error: any }

  return data ?? []
}

const PAYMENT_LABELS: Record<string, string> = {
  pix: 'PIX',
  card: 'Cartão',
  cash: 'Dinheiro',
}

export default async function VendasPage() {
  const sales = await getSales()

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Vendas</h2>
          <p className="text-sm text-text-muted">Últimas {sales.length} vendas</p>
        </div>
        <Link href="/vendas/nova">
          <Button size="sm">
            <Plus className="w-4 h-4" />
            Nova Venda
          </Button>
        </Link>
      </div>

      <Card>
        {sales.length === 0 ? (
          <EmptyState
            icon={<ShoppingCart className="w-6 h-6 text-text-muted" />}
            title="Nenhuma venda registrada"
            description="Registre a primeira venda do sistema."
            action={{ label: 'Nova venda', href: '/vendas/nova' }}
          />
        ) : (
          <>
            <CardHeader>
              <p className="text-xs text-text-muted">{sales.length} vendas</p>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pedido</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead align="right">Total</TableHead>
                  <TableHead align="center">Pagamento</TableHead>
                  <TableHead align="center">Status</TableHead>
                  <TableHead>Vendedor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sales.map((sale) => (
                  <TableRow key={sale.id}>
                    <TableCell>
                      <Link
                        href={`/vendas/${sale.id}`}
                        className="font-mono text-xs text-accent hover:text-accent-muted"
                      >
                        {sale.sale_number}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/clientes/${(sale.customers as any)?.id}`}
                        className="text-sm font-medium hover:text-accent"
                      >
                        {(sale.customers as any)?.name ?? '—'}
                      </Link>
                    </TableCell>
                    <TableCell muted>{formatDate(sale.sale_date)}</TableCell>
                    <TableCell align="right" className="font-semibold">
                      {formatCurrency(sale.total)}
                    </TableCell>
                    <TableCell align="center" muted>
                      <span className="text-xs">{PAYMENT_LABELS[sale.payment_method] ?? '—'}</span>
                    </TableCell>
                    <TableCell align="center">
                      <SaleStatusBadge status={sale.status as SaleStatus} />
                    </TableCell>
                    <TableCell muted>
                      <span className="text-xs">{(sale.users as any)?.name ?? '—'}</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Card>
    </div>
  )
}
