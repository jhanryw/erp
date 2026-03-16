import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { Gift, Settings } from 'lucide-react'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import type { CashbackStatus, CashbackTransactionType } from '@/types/database.types'

const STATUS_CONFIG: Record<CashbackStatus, { label: string; variant: any }> = {
  pending: { label: 'Pendente', variant: 'warning' },
  available: { label: 'Disponível', variant: 'success' },
  used: { label: 'Usado', variant: 'default' },
  expired: { label: 'Expirado', variant: 'error' },
  reversed: { label: 'Estornado', variant: 'error' },
}

const TYPE_LABELS: Record<CashbackTransactionType, string> = {
  earn: 'Acumulado', release: 'Liberado', use: 'Usado', expire: 'Expirado', reverse: 'Estornado',
}

async function getCashbackData() {
  const supabase = createClient()
  const [totals, transactions] = await Promise.all([
    supabase.from('cashback_transactions').select('type, status, amount'),
    supabase
      .from('cashback_transactions')
      .select(`id, type, status, amount, created_at, customers:customer_id (id, name)`)
      .order('created_at', { ascending: false })
      .limit(30),
  ])

  const all = totals.data ?? []
  const pendingTotal = all.filter((t) => t.status === 'pending').reduce((s, t) => s + t.amount, 0)
  const availableTotal = all.filter((t) => t.status === 'available').reduce((s, t) => s + t.amount, 0)
  const usedTotal = all.filter((t) => t.type === 'use').reduce((s, t) => s + t.amount, 0)
  const expiredTotal = all.filter((t) => t.type === 'expire').reduce((s, t) => s + t.amount, 0)

  return { pendingTotal, availableTotal, usedTotal, expiredTotal, transactions: transactions.data ?? [] }
}

export default async function CashbackPage() {
  const { pendingTotal, availableTotal, usedTotal, expiredTotal, transactions } = await getCashbackData()

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Gift className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Cashback</h2>
            <p className="text-sm text-text-muted">Programa de fidelidade</p>
          </div>
        </div>
        <Link href="/cashback/configuracao">
          <Button variant="secondary" size="sm"><Settings className="w-3.5 h-3.5" />Configurar</Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="A Liberar" value={formatCurrency(pendingTotal)} subtitle="aguardando 30 dias" valueClassName="text-warning" />
        <StatCard title="Disponível" value={formatCurrency(availableTotal)} subtitle="pronto para uso" valueClassName="text-success" />
        <StatCard title="Utilizado" value={formatCurrency(usedTotal)} subtitle="usado em compras" />
        <StatCard title="Expirado" value={formatCurrency(expiredTotal)} subtitle="economia para a loja" valueClassName="text-text-muted" />
      </div>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">Transações Recentes</h3>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Cliente</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead align="right">Valor</TableHead>
              <TableHead align="center">Status</TableHead>
              <TableHead>Data</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transactions.map((t) => (
              <TableRow key={t.id}>
                <TableCell>
                  <Link href={`/clientes/${(t.customers as any)?.id}`} className="text-sm font-medium hover:text-accent">
                    {(t.customers as any)?.name ?? '—'}
                  </Link>
                </TableCell>
                <TableCell muted>
                  <span className="text-xs">{TYPE_LABELS[t.type as CashbackTransactionType] ?? t.type}</span>
                </TableCell>
                <TableCell align="right" className="font-semibold">{formatCurrency(t.amount)}</TableCell>
                <TableCell align="center">
                  <Badge variant={STATUS_CONFIG[t.status as CashbackStatus]?.variant ?? 'default'} size="sm">
                    {STATUS_CONFIG[t.status as CashbackStatus]?.label ?? t.status}
                  </Badge>
                </TableCell>
                <TableCell muted>{formatDate(t.created_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
