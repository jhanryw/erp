import { Suspense } from 'react'
import Link from 'next/link'
import { ClipboardList } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePageRole } from '@/lib/auth/requirePageRole'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { PageSearch } from '@/components/ui/page-search'
import { Pagination } from '@/components/ui/pagination'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDateTime } from '@/lib/utils/date'
import { formatPhoneBR } from '@/lib/wholesale/whatsapp'
import { listWholesaleOrders } from '@/services/wholesale/ordersAdmin'
import { ORDER_STATUSES, ORDER_STATUS_LABEL, type WholesaleOrderStatus } from '@/services/wholesale/orderStatus'
import { ORDER_STATUS_VARIANT } from './status'

export const dynamic = 'force-dynamic'

export default async function PedidosAtacadoPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>
}) {
  const { q, status, page } = await searchParams
  const profile = await requirePageRole('usuario')
  const search = q?.trim() || undefined
  const statusFilter = ORDER_STATUSES.find((s) => s === status) as WholesaleOrderStatus | undefined

  // Sempre escopado pela empresa da SESSÃO.
  const result = profile.company_id
    ? await listWholesaleOrders(createAdminClient() as any, profile.company_id, { status: statusFilter, search, page: Number(page) || 1 })
    : { orders: [], total: 0, page: 1, totalPages: 1 }

  const tab = (value: string | undefined, label: string) => {
    const params = new URLSearchParams()
    if (value) params.set('status', value)
    if (search) params.set('q', search)
    const active = value === statusFilter
    return (
      <Link key={label} href={`/pedidos-atacado${params.size ? `?${params}` : ''}`}
        className={`rounded-full px-3 py-1 text-sm ${active ? 'bg-brand text-white' : 'bg-bg-overlay text-text-secondary hover:text-text-primary'}`}>
        {label}
      </Link>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pedidos de Atacado</h1>
        <p className="text-sm text-text-muted">
          Pedidos enviados pelo catálogo de atacado (fechamento no WhatsApp). Não são vendas — não baixam estoque.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Suspense><PageSearch defaultValue={search} placeholder="Buscar por código, nome ou telefone..." /></Suspense>
        <div className="flex gap-2">
          {tab(undefined, 'Todos')}
          {ORDER_STATUSES.map((s) => tab(s, ORDER_STATUS_LABEL[s]))}
        </div>
      </div>

      {result.orders.length === 0 ? (
        <EmptyState
          icon={<ClipboardList className="h-4 w-4" />}
          title={search || statusFilter ? 'Nenhum pedido para os filtros aplicados' : 'Nenhum pedido de atacado ainda'}
          description="Os pedidos aparecem aqui quando um cliente envia o carrinho pelo catálogo."
        />
      ) : (
        <>
          <Card>
            <CardHeader className="text-sm text-text-muted">{result.total} pedido{result.total !== 1 ? 's' : ''}</CardHeader>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Código</TableHead>
                    <TableHead>Data/hora</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead>Telefone</TableHead>
                    <TableHead className="text-right">Peças</TableHead>
                    <TableHead className="text-right">Valor</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.orders.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell><Link href={`/pedidos-atacado/${o.id}`} className="font-mono font-medium hover:underline">{o.code}</Link></TableCell>
                      <TableCell>{formatDateTime(o.createdAt)}</TableCell>
                      <TableCell>{o.customerName}</TableCell>
                      <TableCell>{formatPhoneBR(o.customerPhone)}</TableCell>
                      <TableCell className="text-right tabular-nums">{o.totalItems}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(o.subtotal)}</TableCell>
                      <TableCell><Badge variant={ORDER_STATUS_VARIANT[o.status]}>{ORDER_STATUS_LABEL[o.status]}</Badge></TableCell>
                      <TableCell className="text-right"><Link href={`/pedidos-atacado/${o.id}`}><Button variant="outline" size="sm">Ver</Button></Link></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
          <Pagination page={result.page} totalPages={result.totalPages} baseUrl="/pedidos-atacado" query={search} extraParams={{ status: statusFilter }} />
        </>
      )}
    </div>
  )
}
