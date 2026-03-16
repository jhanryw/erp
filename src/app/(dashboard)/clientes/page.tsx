import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { Plus, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RfmBadge } from '@/components/ui/badge'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import { maskCPF } from '@/lib/utils/cpf'
import type { RfmSegment } from '@/types/database.types'

const ORIGIN_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  referral: 'Indicação',
  paid_traffic: 'Tráfego Pago',
  website: 'Site',
  store: 'Loja',
  other: 'Outro',
}

async function getCustomers() {
  const supabase = createClient()
  const { data } = await supabase
    .from('customers')
    .select(`
      id, name, cpf, phone, city, origin, active, created_at,
      customer_metrics (total_spent, order_count, avg_ticket, last_purchase_date, rfm_segment)
    `)
    .order('created_at', { ascending: false })
    .limit(50) as unknown as { data: any[] | null, error: any }
  return data ?? []
}

export default async function ClientesPage() {
  const customers = await getCustomers()

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Clientes</h2>
          <p className="text-sm text-text-muted">{customers.length} clientes</p>
        </div>
        <Link href="/clientes/novo">
          <Button size="sm">
            <Plus className="w-4 h-4" />
            Novo Cliente
          </Button>
        </Link>
      </div>

      <Card>
        {customers.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nenhum cliente cadastrado"
            description="Cadastre o primeiro cliente."
            action={{ label: 'Cadastrar cliente', onClick: () => {} }}
          />
        ) : (
          <>
            <CardHeader>
              <p className="text-xs text-text-muted">{customers.length} clientes</p>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cliente</TableHead>
                  <TableHead>CPF</TableHead>
                  <TableHead>Origem</TableHead>
                  <TableHead align="right">Total Gasto</TableHead>
                  <TableHead align="right">Compras</TableHead>
                  <TableHead align="right">Ticket Médio</TableHead>
                  <TableHead>Última Compra</TableHead>
                  <TableHead align="center">Segmento</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((customer) => {
                  const metrics = (customer.customer_metrics as any)?.[0] ?? null
                  return (
                    <TableRow key={customer.id}>
                      <TableCell>
                        <Link href={`/clientes/${customer.id}`} className="group">
                          <p className="text-sm font-medium text-text-primary group-hover:text-accent">
                            {customer.name}
                          </p>
                          <p className="text-xs text-text-muted">{customer.phone}</p>
                        </Link>
                      </TableCell>
                      <TableCell muted>
                        <code className="text-xs">{maskCPF(customer.cpf)}</code>
                      </TableCell>
                      <TableCell muted>
                        <span className="text-xs">{ORIGIN_LABELS[customer.origin ?? ''] ?? '—'}</span>
                      </TableCell>
                      <TableCell align="right" className="font-medium">
                        {formatCurrency(metrics?.total_spent ?? 0)}
                      </TableCell>
                      <TableCell align="right" muted>
                        {metrics?.order_count ?? 0}
                      </TableCell>
                      <TableCell align="right" muted>
                        {formatCurrency(metrics?.avg_ticket ?? 0)}
                      </TableCell>
                      <TableCell muted>
                        {metrics?.last_purchase_date
                          ? formatDate(metrics.last_purchase_date)
                          : '—'}
                      </TableCell>
                      <TableCell align="center">
                        {metrics?.rfm_segment ? (
                          <RfmBadge segment={metrics.rfm_segment as RfmSegment} />
                        ) : (
                          <span className="text-xs text-text-muted">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </>
        )}
      </Card>
    </div>
  )
}
