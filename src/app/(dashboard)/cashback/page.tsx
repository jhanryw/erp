import Link from 'next/link'
import { Gift, Settings } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader } from '@/components/ui/card'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import type {
  CashbackStatus,
  CashbackTransactionType,
  Tables,
} from '@/types/database.types'

export const dynamic = 'force-dynamic'

type CashbackRow = Pick<
  Tables<'cashback_transactions'>,
  'type' | 'status' | 'amount'
>

const STATUS_CONFIG: Record<
  CashbackStatus,
  { label: string; variant: 'warning' | 'success' | 'default' | 'error' }
> = {
  pending: { label: 'Pendente', variant: 'warning' },
  available: { label: 'Disponível', variant: 'success' },
  used: { label: 'Usado', variant: 'default' },
  expired: { label: 'Expirado', variant: 'error' },
  reversed: { label: 'Estornado', variant: 'error' },
}

const TYPE_LABELS: Record<CashbackTransactionType, string> = {
  earn: 'Acumulado',
  release: 'Liberado',
  use: 'Usado',
  expire: 'Expirado',
  reverse: 'Estornado',
}

async function getCashbackData() {
  const supabase = createAdminClient()

  const [totals, transactions] = await Promise.all([
    supabase.from('cashback_transactions').select('type, status, amount'),
    supabase
      .from('cashback_transactions')
      .select(`
        id,
        type,
        status,
        amount,
        created_at,
        customers:customer_id (id, name)
      `)
      .order('created_at', { ascending: false })
      .limit(30),
  ])

  if (totals.error) {
    console.error('Erro ao carregar totais de cashback:', totals.error.message)
  }

  if (transactions.error) {
    console.error(
      'Erro ao carregar transações de cashback:',
      transactions.error.message
    )
  }

  const all = (totals.data ?? []) as CashbackRow[]

  const pendingTotal = all
    .filter((t) => t.status === 'pending')
    .reduce((s, t) => s + Number(t.amount ?? 0), 0)

  const availableTotal = all
    .filter((t) => t.status === 'available')
    .reduce((s, t) => s + Number(t.amount ?? 0), 0)

  const usedTotal = all
    .filter((t) => t.type === 'use')
    .reduce((s, t) => s + Number(t.amount ?? 0), 0)

  const expiredTotal = all
    .filter((t) => t.type === 'expire')
    .reduce((s, t) => s + Number(t.amount ?? 0), 0)

  return {
    pendingTotal,
    availableTotal,
    usedTotal,
    expiredTotal,
    transactions: (transactions.data ?? []) as any[],
  }
}

export default async function CashbackPage() {
  const { pendingTotal, availableTotal, usedTotal, expiredTotal, transactions } =
    await getCashbackData()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cashback</h1>
          <p className="text-sm text-muted-foreground">
            Programa de fidelidade
          </p>
        </div>

        <Link href="/cashback/configuracoes">
          <Button>
            <Settings className="mr-2 h-4 w-4" />
            Configurar
          </Button>
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Pendente"
          value={formatCurrency(pendingTotal)}
          icon={<Gift className="h-4 w-4" />}
        />
        <StatCard
          title="Disponível"
          value={formatCurrency(availableTotal)}
          icon={<Gift className="h-4 w-4" />}
        />
        <StatCard
          title="Usado"
          value={formatCurrency(usedTotal)}
          icon={<Gift className="h-4 w-4" />}
        />
        <StatCard
          title="Expirado"
          value={formatCurrency(expiredTotal)}
          icon={<Gift className="h-4 w-4" />}
        />
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Transações Recentes</h2>
        </CardHeader>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Valor</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Data</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {transactions.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>{(t.customers as any)?.name ?? '—'}</TableCell>
                  <TableCell>
                    {TYPE_LABELS[t.type as CashbackTransactionType] ?? t.type}
                  </TableCell>
                  <TableCell>{formatCurrency(t.amount)}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        STATUS_CONFIG[t.status as CashbackStatus]?.variant ??
                        'secondary'
                      }
                    >
                      {STATUS_CONFIG[t.status as CashbackStatus]?.label ??
                        t.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatDate(t.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  )
}