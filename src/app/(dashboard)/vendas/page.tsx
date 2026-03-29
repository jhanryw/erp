import Link from 'next/link'
import { Plus, ShoppingCart } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { Button } from '@/components/ui/button'
import { SaleStatusBadge } from '@/components/ui/badge'
import { Card, CardHeader } from '@/components/ui/card'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import type { SaleStatus } from '@/types/database.types'

export const dynamic = 'force-dynamic'

const PAYMENT_LABELS: Record<string, string> = {
  pix: 'PIX',
  card: 'Cartão',
  cash: 'Dinheiro',
}

type SaleCustomer = {
  id: number
  name: string
  cpf: string | null
}

type SaleUser = {
  id: string | number
  name: string | null
}

type SaleRow = {
  id: number
  sale_number: string
  total: number
  discount_amount: number | null
  cashback_used: number | null
  payment_method: string | null
  status: SaleStatus
  sale_date: string
  created_at: string
  customers: SaleCustomer | SaleCustomer[] | null
  users: SaleUser | SaleUser[] | null
}

async function getSales(): Promise<SaleRow[]> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('sales')
    .select(`
      id,
      sale_number,
      total,
      discount_amount,
      cashback_used,
      payment_method,
      status,
      sale_date,
      created_at,
      customers:customer_id (id, name, cpf),
      users:seller_id (id, name)
    `)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    console.error('Erro ao listar vendas:', error.message)
    return []
  }

  return (data ?? []) as unknown as SaleRow[]
}

export default async function VendasPage() {
  const sales = await getSales()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Vendas</h1>
          <p className="text-sm text-muted-foreground">
            Últimas {sales.length} vendas
          </p>
        </div>

        <Link href="/vendas/nova">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Nova Venda
          </Button>
        </Link>
      </div>

      {sales.length === 0 ? (
        <EmptyState
          icon={<ShoppingCart className="h-4 w-4" />}
          title="Nenhuma venda registrada"
          description="Registre a primeira venda do sistema."
          action={{ label: 'Nova venda', href: '/vendas/nova' }}
      />
      ) : (
        <Card>
          <CardHeader className="text-sm text-muted-foreground">
            {sales.length} vendas
          </CardHeader>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pedido</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Pagamento</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Vendedor</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {sales.map((sale) => {
                  const customer = Array.isArray(sale.customers)
                    ? sale.customers[0] ?? null
                    : sale.customers ?? null

                  const user = Array.isArray(sale.users)
                    ? sale.users[0] ?? null
                    : sale.users ?? null

                  return (
                    <TableRow key={sale.id}>
                      <TableCell className="font-medium">
                        <Link href={`/vendas/${sale.id}`} className="hover:underline font-mono">
                          {sale.sale_number}
                        </Link>
                      </TableCell>

                      <TableCell>
                        <Link href={`/clientes/${customer?.id}`} className="hover:underline">
                          {customer?.name ?? '—'}
                        </Link>
                      </TableCell>

                      <TableCell>{formatDate(sale.sale_date)}</TableCell>

                      <TableCell>{formatCurrency(sale.total)}</TableCell>

                      <TableCell>
                        {PAYMENT_LABELS[sale.payment_method ?? ''] ?? '—'}
                      </TableCell>

                      <TableCell>
                        <SaleStatusBadge status={sale.status} />
                      </TableCell>

                      <TableCell>{user?.name ?? '—'}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  )
}