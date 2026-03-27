import Link from 'next/link'
import { Plus, Users } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { Button } from '@/components/ui/button'
import { RfmBadge } from '@/components/ui/badge'
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
import { maskCPF } from '@/lib/utils/cpf'
import type { RfmSegment } from '@/types/database.types'

export const dynamic = 'force-dynamic'

const ORIGIN_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  referral: 'Indicação',
  paid_traffic: 'Tráfego Pago',
  website: 'Site',
  store: 'Loja',
  other: 'Outro',
}

type CustomerMetricRow = {
  total_spent: number | null
  order_count: number | null
  avg_ticket: number | null
  last_purchase_date: string | null
  rfm_segment: RfmSegment | null
}

type CustomerRow = {
  id: number
  name: string
  cpf: string | null
  phone: string | null
  city: string | null
  origin: string | null
  active: boolean
  created_at: string
  customer_metrics?: CustomerMetricRow[] | CustomerMetricRow | null
}

async function getCustomers(): Promise<CustomerRow[]> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('customers')
    .select(`
      id,
      name,
      cpf,
      phone,
      city,
      origin,
      active,
      created_at,
      customer_metrics (
        total_spent,
        order_count,
        avg_ticket,
        last_purchase_date,
        rfm_segment
      )
    `)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    console.error('Erro ao listar clientes:', error.message)
    return []
  }

  return (data ?? []) as unknown as CustomerRow[]
}

export default async function ClientesPage() {
  const customers = await getCustomers()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Clientes</h1>
          <p className="text-sm text-muted-foreground">
            {customers.length} clientes
          </p>
        </div>

        <Button asChild>
          <Link href="/clientes/novo">
            <Plus className="mr-2 h-4 w-4" />
            Novo Cliente
          </Link>
        </Button>
      </div>

      {customers.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Nenhum cliente cadastrado"
          description="Cadastre o primeiro cliente."
          action={{ label: 'Cadastrar cliente', href: '/clientes/novo' }}
        />
      ) : (
        <>
          <Card>
            <CardHeader className="text-sm text-muted-foreground">
              {customers.length} clientes
            </CardHeader>

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cliente</TableHead>
                    <TableHead>CPF</TableHead>
                    <TableHead>Origem</TableHead>
                    <TableHead>Total Gasto</TableHead>
                    <TableHead>Compras</TableHead>
                    <TableHead>Ticket Médio</TableHead>
                    <TableHead>Última Compra</TableHead>
                    <TableHead>Segmento</TableHead>
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {customers.map((customer) => {
                    const rawMetrics = customer.customer_metrics
                    const metrics = Array.isArray(rawMetrics)
                      ? rawMetrics[0] ?? null
                      : rawMetrics ?? null

                    return (
                      <TableRow key={customer.id}>
                        <TableCell>
                          <div className="font-medium">{customer.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {customer.phone ?? '—'}
                          </div>
                        </TableCell>

                        <TableCell>{customer.cpf ? maskCPF(customer.cpf) : '—'}</TableCell>

                        <TableCell>
                          {ORIGIN_LABELS[customer.origin ?? ''] ?? '—'}
                        </TableCell>

                        <TableCell>
                          {formatCurrency(metrics?.total_spent ?? 0)}
                        </TableCell>

                        <TableCell>{metrics?.order_count ?? 0}</TableCell>

                        <TableCell>
                          {formatCurrency(metrics?.avg_ticket ?? 0)}
                        </TableCell>

                        <TableCell>
                          {metrics?.last_purchase_date
                            ? formatDate(metrics.last_purchase_date)
                            : '—'}
                        </TableCell>

                        <TableCell>
                          {metrics?.rfm_segment ? (
                            <RfmBadge segment={metrics.rfm_segment} />
                          ) : (
                            '—'
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}