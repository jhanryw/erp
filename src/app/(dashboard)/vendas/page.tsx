import { Suspense } from 'react'
import Link from 'next/link'
import { Plus, ShoppingCart } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { getUserProfile } from '@/lib/auth/getProfile'
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
import { PageSearch } from '@/components/ui/page-search'
import { Pagination } from '@/components/ui/pagination'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import { ORIGIN_LABELS, ORIGIN_COLORS } from '@/lib/constants/origins'
import type { SaleStatus } from '@/types/database.types'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

const PAYMENT_LABELS: Record<string, string> = {
  pix:         'PIX',
  card:        'Cartão',
  cash:        'Dinheiro',
  credit_card: 'Crédito',
  debit_card:  'Débito',
  digital_wallet: 'Carteira digital',
  boleto:      'Boleto',
  cashback:    'Crédito de Troca',
}

/** Canais filtráveis (sales.sales_channel). */
const CHANNEL_FILTERS: Record<string, string> = {
  mercadolivre: 'Mercado Livre',
  nuvemshop:    'Nuvemshop',
  pos:          'PDV',
}

type SaleCustomer = { id: number; name: string; cpf: string | null }
type SaleUser     = { id: string | number; name: string | null }

type SaleRow = {
  id:              number
  sale_number:     string
  total:           number
  discount_amount: number | null
  cashback_used:   number | null
  payment_method:  string | null
  sale_origin:     string | null
  sales_channel:   string | null
  status:          SaleStatus
  sale_date:       string
  created_at:      string
  customers:       SaleCustomer | SaleCustomer[] | null
  sellers:         SaleUser | SaleUser[] | null
  has_exchange:    boolean
}

async function getSales(companyId: number, search?: string, page = 1, channel?: string) {
  const supabase = createAdminClient()

  let query = supabase
    .from('sales')
    .select(`
      id, sale_number, total, discount_amount, cashback_used,
      payment_method, sale_origin, sales_channel, status, sale_date, created_at,
      customers:customer_id (id, name, cpf),
      sellers:responsible_seller_id (id, name)
    `, { count: 'exact' })
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })

  if (channel && CHANNEL_FILTERS[channel]) query = (query as any).eq('sales_channel', channel)

  if (search) {
    // Filtra por número do pedido ou, via join, por nome do cliente
    // Supabase não suporta ilike em relações — filtramos sale_number aqui;
    // a busca por nome retorna via OR no sale_number (prefixo) ou fazemos
    // uma query separada de customer_ids quando parecer nome
    const likelyName = /[a-zA-ZÀ-ú]/.test(search)

    if (likelyName) {
      // Busca os IDs dos clientes cujo nome bate, depois filtra as vendas
      const { data: matchingCustomers } = await supabase
        .from('customers')
        .select('id')
        .ilike('name', `%${search}%`)
        .limit(200)
      const ids = (matchingCustomers ?? []).map((c: any) => c.id)

      if (ids.length > 0) {
        query = (query as any).or(
          `sale_number.ilike.%${search}%,customer_id.in.(${ids.join(',')})`,
        )
      } else {
        query = (query as any).ilike('sale_number', `%${search}%`)
      }
    } else {
      query = (query as any).ilike('sale_number', `%${search}%`)
    }
  } else {
    const from = (page - 1) * PAGE_SIZE
    const to   = from + PAGE_SIZE - 1
    query = (query as any).range(from, to)
  }

  const { data, error, count } = await query as any

  if (error) {
    console.error('Erro ao listar vendas:', error.message)
    return { sales: [] as SaleRow[], total: 0, error: error.message as string }
  }

  const rows = (data ?? []) as SaleRow[]

  // "Trocado" (2026-09-15) — troca não altera mais sales.status, então o
  // selo vem de EXISTS(exchanges), nunca do status. Uma única query extra
  // por página (nunca por linha), escopada aos ids já carregados.
  const saleIds = rows.map((s) => s.id)
  let exchangedIds = new Set<number>()
  if (saleIds.length > 0) {
    const { data: exchangeRows } = await supabase
      .from('exchanges')
      .select('original_sale_id')
      .in('original_sale_id', saleIds) as unknown as { data: { original_sale_id: number }[] | null }
    exchangedIds = new Set((exchangeRows ?? []).map((e) => e.original_sale_id))
  }

  return {
    sales: rows.map((s) => ({ ...s, has_exchange: exchangedIds.has(s.id) })),
    total: (count ?? 0) as number,
    error: null,
  }
}

export default async function VendasPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; canal?: string }>
}) {
  const { q, page: pageParam, canal } = await searchParams
  const channel = canal && CHANNEL_FILTERS[canal] ? canal : undefined
  const search = q?.trim() || undefined
  const page   = Math.max(1, parseInt(pageParam ?? '1') || 1)

  // Autenticação
  const serverClient = createClient()
  const { data: { user: authUser } } = await serverClient.auth.getUser()
  if (!authUser) {
    return (
      <div className="rounded-lg border border-error/30 bg-error/5 px-4 py-3 text-sm text-error">
        Não autenticado.
      </div>
    )
  }
  const profile = await getUserProfile(authUser.id, authUser.email)
  if (!profile.company_id) {
    return (
      <div className="rounded-lg border border-error/30 bg-error/5 px-4 py-3 text-sm text-error">
        Usuário sem empresa vinculada.
      </div>
    )
  }

  const { sales, total, error } = await getSales(profile.company_id, search, page, channel)
  const totalPages = search ? 1 : Math.ceil(total / PAGE_SIZE)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Vendas</h1>
          <p className="text-sm text-muted-foreground">
            {total} venda{total !== 1 ? 's' : ''} registrada{total !== 1 ? 's' : ''}
          </p>
        </div>

        <Link href="/vendas/nova">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Nova Venda
          </Button>
        </Link>
      </div>

      <Suspense>
        <PageSearch defaultValue={q} placeholder="Buscar por nº do pedido ou nome do cliente..." />
      </Suspense>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-text-muted">Canal:</span>
        <Link href="/vendas" className={`rounded-full border px-2.5 py-1 ${!channel ? 'border-brand bg-brand/10 text-brand' : 'border-border hover:bg-bg-overlay'}`}>Todos</Link>
        {Object.entries(CHANNEL_FILTERS).map(([key, label]) => (
          <Link key={key} href={`/vendas?canal=${key}`}
            className={`rounded-full border px-2.5 py-1 ${channel === key ? 'border-brand bg-brand/10 text-brand' : 'border-border hover:bg-bg-overlay'}`}>
            {label}
          </Link>
        ))}
        <Link href="/vendas/marketplace" className="ml-auto text-brand hover:underline">Pedidos de marketplace →</Link>
      </div>

      {error && (
        <div className="rounded-lg border border-error/30 bg-error/5 px-4 py-3 text-sm text-error">
          Erro ao carregar vendas: {error}
        </div>
      )}

      {!error && sales.length === 0 ? (
        <EmptyState
          icon={<ShoppingCart className="h-4 w-4" />}
          title={search ? `Nenhuma venda encontrada para "${search}"` : 'Nenhuma venda registrada'}
          description={search ? 'Tente outro termo de busca.' : 'Registre a primeira venda do sistema.'}
          action={search ? undefined : { label: 'Nova venda', href: '/vendas/nova' }}
        />
      ) : (
        <Card>
          <CardHeader className="text-sm text-muted-foreground">
            {search
              ? `${sales.length} resultado${sales.length !== 1 ? 's' : ''} para "${search}"`
              : `${sales.length} de ${total} vendas — página ${page} de ${totalPages}`}
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
                  <TableHead>Origem</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Vendedor</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {sales.map((sale) => {
                  const customer = Array.isArray(sale.customers)
                    ? sale.customers[0] ?? null
                    : sale.customers ?? null

                  const seller = Array.isArray(sale.sellers)
                    ? sale.sellers[0] ?? null
                    : sale.sellers ?? null

                  return (
                    <TableRow key={sale.id}>
                      <TableCell className="font-medium">
                        <Link href={`/vendas/${sale.id}`} className="hover:underline font-mono">
                          {sale.sale_number}
                        </Link>
                      </TableCell>

                      <TableCell>
                        {customer ? (
                          <Link href={`/clientes/${customer.id}`} className="hover:underline">
                            {customer.name}
                          </Link>
                        ) : '—'}
                      </TableCell>

                      <TableCell>{formatDate(sale.sale_date)}</TableCell>

                      <TableCell className="tabular-nums">{formatCurrency(sale.total)}</TableCell>

                      <TableCell>
                        {PAYMENT_LABELS[sale.payment_method ?? ''] ?? sale.payment_method ?? '—'}
                      </TableCell>

                      <TableCell>
                        {sale.sales_channel === 'mercadolivre' ? (
                          <span className="inline-flex items-center rounded-full bg-[#FFE600] px-2 py-0.5 text-xs font-medium text-[#2D3277]">
                            Mercado Livre
                          </span>
                        ) : sale.sale_origin ? (
                          <span
                            className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium text-white"
                            style={{ backgroundColor: ORIGIN_COLORS[sale.sale_origin] ?? ORIGIN_COLORS.other }}
                          >
                            {ORIGIN_LABELS[sale.sale_origin] ?? sale.sale_origin}
                          </span>
                        ) : (
                          <span className="text-xs text-text-muted">—</span>
                        )}
                      </TableCell>

                      <TableCell>
                        <SaleStatusBadge status={sale.status} hasExchange={sale.has_exchange} />
                      </TableCell>

                      <TableCell>{seller?.name ?? '—'}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          {!search && totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} baseUrl="/vendas" query={search} extraParams={channel ? { canal: channel } : undefined} />
          )}
        </Card>
      )}
    </div>
  )
}
