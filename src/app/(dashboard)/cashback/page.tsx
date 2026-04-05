import { requirePageRole } from '@/lib/auth/requirePageRole'
import { getUserProfile } from '@/lib/supabase/session'
import Link from 'next/link'
import { Gift, Settings, Clock, Percent, ShoppingBag, Wallet } from 'lucide-react'

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
  pending:  { label: 'Pendente',  variant: 'warning' },
  available:{ label: 'Disponível',variant: 'success' },
  used:     { label: 'Usado',     variant: 'default' },
  expired:  { label: 'Expirado',  variant: 'error'   },
  reversed: { label: 'Estornado', variant: 'error'   },
}

const TYPE_LABELS: Record<CashbackTransactionType, string> = {
  earn:    'Acumulado',
  release: 'Liberado',
  use:     'Usado',
  expire:  'Expirado',
  reverse: 'Estornado',
}

async function getCashbackData(companyId: number | null) {
  const admin = createAdminClient()

  // Buscar config ativa da empresa
  const { data: config } = await (admin as any)
    .from('cashback_config')
    .select('*')
    .eq('company_id', companyId)
    .eq('active', true)
    .maybeSingle() as unknown as { data: any }

  const [totals, transactions] = await Promise.all([
    admin.from('cashback_transactions').select('type, status, amount'),
    admin
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
      .limit(50),
  ])

  const all = (totals.data ?? []) as CashbackRow[]

  const pendingTotal  = all.filter((t) => t.status === 'pending').reduce((s, t) => s + Number(t.amount ?? 0), 0)
  const availableTotal= all.filter((t) => t.status === 'available').reduce((s, t) => s + Number(t.amount ?? 0), 0)
  const usedTotal     = all.filter((t) => t.type === 'use').reduce((s, t) => s + Number(t.amount ?? 0), 0)
  const expiredTotal  = all.filter((t) => t.type === 'expire').reduce((s, t) => s + Number(t.amount ?? 0), 0)

  return {
    config,
    pendingTotal,
    availableTotal,
    usedTotal,
    expiredTotal,
    transactions: (transactions.data ?? []) as any[],
  }
}

export default async function CashbackPage() {
  await requirePageRole('gerente')
  const user = await getUserProfile()
  const { config, pendingTotal, availableTotal, usedTotal, expiredTotal, transactions } =
    await getCashbackData(user?.company_id ?? null)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cashback</h1>
          <p className="text-sm text-text-muted">Programa de fidelidade</p>
        </div>
        <Link href="/cashback/configuracao">
          <Button>
            <Settings className="mr-2 h-4 w-4" />
            Configurar
          </Button>
        </Link>
      </div>

      {/* Regras ativas em destaque */}
      {config ? (
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Gift className="w-4 h-4 text-brand" />
            <h3 className="text-sm font-semibold text-text-primary">Regras Ativas do Programa</h3>
            <Badge variant="success" size="sm">Ativo</Badge>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="flex flex-col gap-1 p-3 rounded-lg bg-bg-overlay">
              <div className="flex items-center gap-1.5 text-xs text-text-muted">
                <Percent className="w-3.5 h-3.5" />
                Percentual
              </div>
              <span className="text-xl font-bold text-brand">{config.rate_pct}%</span>
              <span className="text-xs text-text-muted">do valor da compra</span>
            </div>
            <div className="flex flex-col gap-1 p-3 rounded-lg bg-bg-overlay">
              <div className="flex items-center gap-1.5 text-xs text-text-muted">
                <ShoppingBag className="w-3.5 h-3.5" />
                Pedido mínimo
              </div>
              <span className="text-xl font-bold text-text-primary">
                {config.min_order_value > 0 ? formatCurrency(config.min_order_value) : 'Qualquer valor'}
              </span>
              <span className="text-xs text-text-muted">para acumular</span>
            </div>
            <div className="flex flex-col gap-1 p-3 rounded-lg bg-bg-overlay">
              <div className="flex items-center gap-1.5 text-xs text-text-muted">
                <Clock className="w-3.5 h-3.5" />
                Liberação
              </div>
              <span className="text-xl font-bold text-text-primary">{config.release_days} dias</span>
              <span className="text-xs text-text-muted">após a compra</span>
            </div>
            <div className="flex flex-col gap-1 p-3 rounded-lg bg-bg-overlay">
              <div className="flex items-center gap-1.5 text-xs text-text-muted">
                <Wallet className="w-3.5 h-3.5" />
                Uso mínimo
              </div>
              <span className="text-xl font-bold text-text-primary">{formatCurrency(config.min_use_value)}</span>
              <span className="text-xs text-text-muted">
                expira em {config.expiry_days} dias
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="card p-5 border-dashed border-warning/40 bg-warning/5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Gift className="w-5 h-5 text-warning" />
            <div>
              <p className="text-sm font-medium text-text-primary">Programa de cashback não configurado</p>
              <p className="text-xs text-text-muted">Configure as regras para começar a oferecer cashback às clientes.</p>
            </div>
          </div>
          <Link href="/cashback/configuracao">
            <Button size="sm">Configurar agora</Button>
          </Link>
        </div>
      )}

      {/* Métricas */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Pendente (a liberar)"  value={formatCurrency(pendingTotal)}   icon={<Gift className="h-4 w-4" />} />
        <StatCard title="Disponível nas clientes" value={formatCurrency(availableTotal)} icon={<Wallet className="h-4 w-4" />} />
        <StatCard title="Já resgatado"           value={formatCurrency(usedTotal)}      icon={<ShoppingBag className="h-4 w-4" />} />
        <StatCard title="Expirado"               value={formatCurrency(expiredTotal)}   icon={<Clock className="h-4 w-4" />} />
      </div>

      {/* Transações */}
      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold text-text-primary">Transações Recentes</h2>
        </CardHeader>
        <div className="overflow-x-auto">
          {transactions.length === 0 ? (
            <div className="py-12 text-center">
              <Gift className="w-8 h-8 text-text-muted mx-auto mb-2" />
              <p className="text-sm text-text-muted">Nenhuma transação ainda.</p>
              <p className="text-xs text-text-muted mt-1">O cashback é gerado automaticamente a cada venda concluída.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead align="right">Valor</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Data</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transactions.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <Link href={`/clientes/${(t.customers as any)?.id}`} className="hover:text-text-primary transition-colors">
                        {(t.customers as any)?.name ?? '—'}
                      </Link>
                    </TableCell>
                    <TableCell muted>
                      {TYPE_LABELS[t.type as CashbackTransactionType] ?? t.type}
                    </TableCell>
                    <TableCell align="right" className="font-medium">
                      {formatCurrency(t.amount)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_CONFIG[t.status as CashbackStatus]?.variant ?? 'default'} size="sm">
                        {STATUS_CONFIG[t.status as CashbackStatus]?.label ?? t.status}
                      </Badge>
                    </TableCell>
                    <TableCell muted>{formatDate(t.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>
    </div>
  )
}
