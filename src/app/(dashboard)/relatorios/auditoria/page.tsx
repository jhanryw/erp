export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePageRole } from '@/lib/auth/requirePageRole'
import { formatDateTime } from '@/lib/utils/date'
import { Shield, AlertTriangle, RotateCcw, Scissors, TrendingDown, Trash2, Lock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'

type AuditRow = {
  id: number
  ts: string
  user_id: string | null
  user_role: string | null
  action: string
  resource: string
  resource_id: string | null
  before_data: Record<string, unknown> | null
  after_data: Record<string, unknown> | null
  detail: string | null
  users: { name: string } | null
}

const AUDIT_ACTIONS = [
  'cancel', 'return', 'delete', 'adjust',
  'close_cash', 'open_cash', 'reopen_cash',
  'cancel_movement', 'update',
]

async function getLogs(): Promise<AuditRow[]> {
  const admin = createAdminClient()
  const { data } = await (admin as any)
    .from('audit_logs')
    .select('id, ts, user_id, user_role, action, resource, resource_id, before_data, after_data, detail, users(name)')
    .in('action', AUDIT_ACTIONS)
    .order('ts', { ascending: false })
    .limit(200) as { data: AuditRow[] | null }
  return data ?? []
}

function actionBadge(action: string) {
  const map: Record<string, { variant: 'error' | 'warning' | 'default'; label: string }> = {
    cancel:          { variant: 'error',   label: 'Cancelamento' },
    return:          { variant: 'warning', label: 'Devolução' },
    delete:          { variant: 'error',   label: 'Exclusão' },
    adjust:          { variant: 'warning', label: 'Ajuste estoque' },
    reopen_cash:     { variant: 'error',   label: 'Reabertura caixa' },
    close_cash:      { variant: 'default', label: 'Fechamento caixa' },
    open_cash:       { variant: 'default', label: 'Abertura caixa' },
    cancel_movement: { variant: 'warning', label: 'Cancel. movimento' },
    update:          { variant: 'default', label: 'Alteração' },
  }
  const cfg = map[action] ?? { variant: 'default' as const, label: action }
  return <Badge variant={cfg.variant} size="sm">{cfg.label}</Badge>
}

function resourceLabel(resource: string): string {
  const map: Record<string, string> = {
    sale:                    'Venda',
    finance_entry:           'Lançamento financeiro',
    stock_adjustment:        'Estoque',
    cash_session:            'Sessão de caixa',
    cash_register_sessions:  'Sessão de caixa',
    cash_movement:           'Movimento caixa',
    cash_movements:          'Movimento caixa',
    users:                   'Usuário',
    product:                 'Produto',
  }
  return map[resource] ?? resource
}

function ActionIcon({ action }: { action: string }) {
  const cls = 'w-4 h-4 flex-shrink-0'
  if (action === 'reopen_cash')     return <RotateCcw  className={`${cls} text-error`} />
  if (action === 'cancel_movement') return <Scissors   className={`${cls} text-warning`} />
  if (action === 'delete')          return <Trash2     className={`${cls} text-error`} />
  if (action === 'cancel')          return <AlertTriangle className={`${cls} text-error`} />
  if (action === 'adjust')          return <TrendingDown  className={`${cls} text-warning`} />
  if (action === 'close_cash')      return <Lock       className={`${cls} text-text-muted`} />
  return <Shield className={`${cls} text-text-muted`} />
}

function diffBadge(row: AuditRow) {
  if (row.action !== 'close_cash') return null
  const diff = (row.after_data?.cash_difference as number | undefined) ?? null
  if (diff == null) return null
  if (diff === 0) return null
  const fmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Math.abs(diff))
  return (
    <span className={`text-xs font-semibold tabular-nums ${diff < 0 ? 'text-error' : 'text-success'}`}>
      {diff < 0 ? '−' : '+'}{fmt}
    </span>
  )
}

export default async function AuditoriaPage() {
  await requirePageRole('gerente')
  const logs = await getLogs()

  const highRisk = logs.filter((l) => ['reopen_cash', 'cancel', 'delete'].includes(l.action))

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Shield className="w-5 h-5 text-text-muted" />
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Relatório de Auditoria</h2>
          <p className="text-sm text-text-muted">{logs.length} eventos auditados</p>
        </div>
      </div>

      {/* Alertas de alto risco */}
      {highRisk.length > 0 && (
        <div className="card p-4 border-error/30 bg-error/5 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-error" />
            <p className="text-sm font-semibold text-error">
              {highRisk.length} evento{highRisk.length > 1 ? 's' : ''} de alto risco
            </p>
          </div>
          <p className="text-xs text-text-secondary">
            Inclui reaberturas de caixa, cancelamentos de venda e exclusões.
          </p>
        </div>
      )}

      <Card>
        {logs.length === 0 ? (
          <EmptyState
            icon={<Shield className="w-6 h-6 text-text-muted" />}
            title="Nenhum evento auditado ainda"
            description="Os eventos de auditoria aparecerão aqui conforme o sistema for utilizado."
          />
        ) : (
          <>
            <CardHeader>
              <p className="text-xs text-text-muted">Últimos {logs.length} eventos · mais recente primeiro</p>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data/Hora</TableHead>
                  <TableHead>Usuário</TableHead>
                  <TableHead>Perfil</TableHead>
                  <TableHead>Ação</TableHead>
                  <TableHead>Recurso</TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead>Detalhe</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow
                    key={log.id}
                    className={['reopen_cash', 'cancel', 'delete'].includes(log.action) ? 'bg-error/5' : ''}
                  >
                    <TableCell muted className="whitespace-nowrap text-xs">
                      {formatDateTime(log.ts)}
                    </TableCell>
                    <TableCell className="text-sm">
                      <div className="flex items-center gap-1.5">
                        <ActionIcon action={log.action} />
                        <span>{log.users?.name ?? log.user_id?.slice(0, 8) ?? '—'}</span>
                      </div>
                    </TableCell>
                    <TableCell muted className="text-xs capitalize">
                      {log.user_role ?? '—'}
                    </TableCell>
                    <TableCell>{actionBadge(log.action)}</TableCell>
                    <TableCell muted className="text-xs">
                      {resourceLabel(log.resource)}
                    </TableCell>
                    <TableCell muted className="text-xs tabular-nums">
                      {log.resource_id ?? '—'}
                    </TableCell>
                    <TableCell className="text-xs text-text-secondary max-w-[200px] truncate">
                      {diffBadge(log) ?? log.detail ?? '—'}
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
