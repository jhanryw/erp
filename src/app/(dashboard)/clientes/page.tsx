import { Suspense } from 'react'
import Link from 'next/link'
import { Plus, Users, ChevronRight, Cake } from 'lucide-react'

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
import { PageSearch } from '@/components/ui/page-search'
import { Pagination } from '@/components/ui/pagination'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import { maskCPF } from '@/lib/utils/cpf'
import type { RfmSegment } from '@/types/database.types'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

const ORIGIN_LABELS: Record<string, string> = {
  instagram:    'Instagram',
  referral:     'Indicação',
  paid_traffic: 'Tráfego Pago',
  website:      'Site',
  store:        'Loja',
  other:        'Outro',
}

type CustomerMetricRow = {
  total_spent:        number | null
  order_count:        number | null
  avg_ticket:         number | null
  last_purchase_date: string | null
  rfm_segment:        RfmSegment | null
}

type CustomerRow = {
  id:         number
  name:       string
  cpf:        string | null
  phone:      string | null
  city:       string | null
  origin:     string | null
  active:     boolean
  created_at: string
  customer_metrics?: CustomerMetricRow[] | CustomerMetricRow | null
}

async function getCustomers(search?: string, page = 1) {
  const supabase = createAdminClient()

  let query = (supabase as any)
    .from('customers')
    .select(`
      id, name, cpf, phone, city, origin, active, created_at,
      customer_metrics (
        total_spent, order_count, avg_ticket, last_purchase_date, rfm_segment
      )
    `, { count: 'exact' })
    .eq('is_anonymous', false)
    .order('created_at', { ascending: false })

  if (search) {
    query = query.or(
      `name.ilike.%${search}%,cpf.ilike.%${search}%,phone.ilike.%${search}%`,
    )
  } else {
    // Paginação só quando não há busca
    const from = (page - 1) * PAGE_SIZE
    const to   = from + PAGE_SIZE - 1
    query = query.range(from, to)
  }

  const { data, error, count } = await query

  if (error) {
    console.error('Erro ao listar clientes:', error.message)
    return { customers: [] as CustomerRow[], total: 0 }
  }

  return {
    customers: (data ?? []) as unknown as CustomerRow[],
    total:     count ?? 0,
  }
}

export default async function ClientesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>
}) {
  const { q, page: pageParam } = await searchParams
  const search     = q?.trim() || undefined
  const page       = Math.max(1, parseInt(pageParam ?? '1') || 1)
  const { customers, total } = await getCustomers(search, page)
  const totalPages = search ? 1 : Math.ceil(total / PAGE_SIZE)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Clientes</h1>
          <p className="text-sm text-muted-foreground">
            {total} cliente{total !== 1 ? 's' : ''} cadastrado{total !== 1 ? 's' : ''}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link href="/clientes/aniversariantes">
            <Button variant="outline">
              <Cake className="mr-2 h-4 w-4" />
              Aniversariantes
            </Button>
          </Link>
          <Link href="/clientes/novo">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Novo Cliente
            </Button>
          </Link>
        </div>
      </div>

      <Suspense>
        <PageSearch defaultValue={q} placeholder="Buscar por nome, CPF ou telefone..." />
      </Suspense>

      {customers.length === 0 ? (
        <EmptyState
          icon={<Users className="h-4 w-4" />}
          title={search ? `Nenhum cliente encontrado para "${search}"` : 'Nenhum cliente cadastrado'}
          description={search ? 'Tente outro termo de busca.' : 'Cadastre o primeiro cliente.'}
          action={search ? undefined : { label: 'Cadastrar cliente', href: '/clientes/novo' }}
        />
      ) : (
        <Card>
          <CardHeader className="text-sm text-muted-foreground">
            {search
              ? `${customers.length} resultado${customers.length !== 1 ? 's' : ''} para "${search}"`
              : `${customers.length} de ${total} clientes — página ${page} de ${totalPages}`}
          </CardHeader>

          {/* ── Mobile: lista em cards ─────────────────────────── */}
          <div className="md:hidden divide-y divide-border">
            {customers.map((customer) => {
              const rawMetrics = customer.customer_metrics
              const metrics = Array.isArray(rawMetrics)
                ? rawMetrics[0] ?? null
                : rawMetrics ?? null

              return (
                <Link
                  key={customer.id}
                  href={`/clientes/${customer.id}`}
                  className="flex items-center gap-3 px-4 py-3.5 hover:bg-bg-hover active:bg-bg-hover transition-colors"
                >
                  <div className="w-10 h-10 rounded-full bg-brand/15 flex items-center justify-center flex-shrink-0">
                    <span className="text-sm font-bold text-brand">
                      {customer.name.charAt(0).toUpperCase()}
                    </span>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-text-primary truncate">{customer.name}</p>
                      {metrics?.rfm_segment && (
                        <RfmBadge segment={metrics.rfm_segment} />
                      )}
                    </div>
                    <p className="text-xs text-text-muted mt-0.5">
                      {customer.phone ?? '—'}
                      {customer.origin && ` · ${ORIGIN_LABELS[customer.origin] ?? customer.origin}`}
                    </p>
                    <div className="flex gap-3 mt-1.5 text-xs">
                      <span className="text-text-muted">
                        Gasto:{' '}
                        <span className="text-text-primary font-semibold">
                          {formatCurrency(metrics?.total_spent ?? 0)}
                        </span>
                      </span>
                      <span className="text-text-muted">
                        {metrics?.order_count ?? 0} compra{(metrics?.order_count ?? 0) !== 1 ? 's' : ''}
                      </span>
                      {metrics?.last_purchase_date && (
                        <span className="text-text-muted hidden xs:inline">
                          Última: {formatDate(metrics.last_purchase_date)}
                        </span>
                      )}
                    </div>
                  </div>

                  <ChevronRight className="w-4 h-4 text-text-muted flex-shrink-0" />
                </Link>
              )
            })}
          </div>

          {/* ── Desktop: tabela completa ───────────────────────── */}
          <div className="hidden md:block overflow-x-auto">
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
                        <Link href={`/clientes/${customer.id}`} className="hover:underline">
                          <div className="font-medium">{customer.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {customer.phone ?? '—'}
                          </div>
                        </Link>
                      </TableCell>
                      <TableCell>{customer.cpf ? maskCPF(customer.cpf) : '—'}</TableCell>
                      <TableCell>{ORIGIN_LABELS[customer.origin ?? ''] ?? '—'}</TableCell>
                      <TableCell>{formatCurrency(metrics?.total_spent ?? 0)}</TableCell>
                      <TableCell>{metrics?.order_count ?? 0}</TableCell>
                      <TableCell>{formatCurrency(metrics?.avg_ticket ?? 0)}</TableCell>
                      <TableCell>
                        {metrics?.last_purchase_date ? formatDate(metrics.last_purchase_date) : '—'}
                      </TableCell>
                      <TableCell>
                        {metrics?.rfm_segment ? <RfmBadge segment={metrics.rfm_segment} /> : '—'}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          {!search && totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} baseUrl="/clientes" query={search} />
          )}
        </Card>
      )}
    </div>
  )
}
