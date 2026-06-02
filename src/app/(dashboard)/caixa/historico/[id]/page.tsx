export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { getUserProfile } from '@/lib/auth/getProfile'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import { Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ReabrirCaixaButton } from './_components/reabrir-button'

async function getSession(id: number) {
  const admin = createAdminClient()
  const { data } = await admin
    .from('cash_register_sessions')
    .select('*')
    .eq('id', id)
    .eq('status', 'closed')
    .maybeSingle() as unknown as { data: Record<string, any> | null }
  return data
}

async function getMovements(sessionId: number) {
  const admin = createAdminClient()
  const { data } = await admin
    .from('cash_movements')
    .select('id, type, method, amount, description, created_at, cancelled_at')
    .eq('cash_session_id', sessionId)
    .order('created_at', { ascending: true }) as unknown as { data: any[] | null }
  return data ?? []
}

const TYPE_LABEL: Record<string, string> = {
  sangria:    'Sangria',
  suprimento: 'Suprimento',
  expense:    'Despesa',
}

const METHOD_LABEL: Record<string, string> = {
  cash:        'Dinheiro',
  pix:         'PIX',
  credit_card: 'Crédito',
  debit_card:  'Débito',
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: 'success' | 'error' | 'default' }) {
  const color = highlight === 'success' ? 'text-success' : highlight === 'error' ? 'text-error' : 'text-text-primary'
  return (
    <div className="flex justify-between items-center py-2.5 border-b border-border/50 last:border-0">
      <span className="text-sm text-text-secondary">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${color}`}>{value}</span>
    </div>
  )
}

export default async function DetalheCaixaPage({ params }: { params: { id: string } }) {
  const id = parseInt(params.id, 10)
  if (isNaN(id)) notFound()

  const supabase = createClient()
  const { data: { user: authUser } } = await supabase.auth.getUser()
  const profile = authUser ? await getUserProfile(authUser.id, authUser.email) : null
  const isAdmin = profile?.role === 'admin'

  const [session, movements] = await Promise.all([getSession(id), getMovements(id)])
  if (!session) notFound()

  const diff = session.cash_difference ?? 0

  return (
    <div className="max-w-lg mx-auto space-y-5 pb-10">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Wallet className="w-5 h-5 text-text-muted" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Caixa #{session.id}</h2>
            <p className="text-sm text-text-muted">{formatDate(session.opened_at)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && <ReabrirCaixaButton sessionId={id} />}
          <Link href="/caixa/historico">
            <Button variant="secondary" size="sm">← Histórico</Button>
          </Link>
        </div>
      </div>

      {/* Resumo financeiro */}
      <div className="card p-5 space-y-1">
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Resumo</p>
        <Row label="Total de vendas"   value={formatCurrency(session.total_sales ?? 0)} />
        <Row label="Recebido em dinheiro" value={formatCurrency(session.total_cash ?? 0)} />
        <Row label="Recebido em PIX"   value={formatCurrency(session.total_pix ?? 0)} />
        <Row label="Cartão de crédito" value={formatCurrency(session.total_credit_card ?? 0)} />
        <Row label="Cartão de débito"  value={formatCurrency(session.total_debit_card ?? 0)} />
        <Row label="Taxas de cartão"   value={`- ${formatCurrency(session.total_card_fees ?? 0)}`} />
      </div>

      {/* Movimentos do caixa */}
      <div className="card p-5 space-y-1">
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Movimentos</p>
        <Row label="Fundo inicial"  value={formatCurrency(session.opening_amount_cash ?? 0)} />
        <Row label="Suprimentos"    value={`+ ${formatCurrency(session.total_suprimento ?? 0)}`} />
        <Row label="Sangrias"       value={`- ${formatCurrency(session.total_sangria ?? 0)}`} />
        <Row label="Despesas"       value={`- ${formatCurrency(session.total_expenses ?? 0)}`} />
      </div>

      {/* Conferência */}
      <div className="card p-5 space-y-1">
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Conferência</p>
        <Row label="Esperado em caixa" value={formatCurrency(session.expected_cash ?? 0)} />
        <Row label="Contado"           value={formatCurrency(session.counted_cash ?? 0)} />
        <Row
          label="Diferença"
          value={`${diff > 0 ? '+' : ''}${formatCurrency(diff)}`}
          highlight={diff === 0 ? 'default' : diff > 0 ? 'success' : 'error'}
        />
      </div>

      {/* Log de movimentos */}
      {movements.length > 0 && (
        <div className="card p-5">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Detalhes dos movimentos</p>
          <div className="space-y-2">
            {movements.map((m) => (
              <div
                key={m.id}
                className={`flex justify-between items-start py-2 border-b border-border/40 last:border-0 ${m.cancelled_at ? 'opacity-40 line-through' : ''}`}
              >
                <div>
                  <p className="text-sm text-text-primary">{TYPE_LABEL[m.type] ?? m.type}</p>
                  <p className="text-xs text-text-muted">{m.description} · {METHOD_LABEL[m.method] ?? m.method}</p>
                </div>
                <span className={`text-sm font-semibold tabular-nums ${m.type === 'suprimento' ? 'text-success' : 'text-error'}`}>
                  {m.type === 'suprimento' ? '+' : '−'} {formatCurrency(m.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {session.notes_close && (
        <div className="card p-4">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">Observações</p>
          <p className="text-sm text-text-secondary">{session.notes_close}</p>
        </div>
      )}
    </div>
  )
}
