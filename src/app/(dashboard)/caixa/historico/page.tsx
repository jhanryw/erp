export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePageRole } from '@/lib/auth/requirePageRole'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import { Wallet, ChevronRight } from 'lucide-react'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Card, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

type Session = {
  id: number
  opened_at: string
  closed_at: string | null
  status: string
  opening_amount_cash: number
  counted_cash: number | null
  expected_cash: number | null
  total_sales: number | null
  total_cash: number | null
  total_pix: number | null
  total_credit_card: number | null
  total_debit_card: number | null
  total_sangria: number | null
  total_suprimento: number | null
  total_expenses: number | null
  cash_difference: number | null
}

async function getSessions(companyId: number): Promise<Session[]> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('cash_register_sessions')
    .select(`
      id, status, opened_at, closed_at, opening_amount_cash,
      counted_cash, expected_cash,
      total_sales, total_cash, total_pix, total_credit_card, total_debit_card,
      total_sangria, total_suprimento, total_expenses, cash_difference
    `)
    .eq('company_id', companyId)
    .order('opened_at', { ascending: false })
    .limit(60) as unknown as { data: Session[] | null }
  return data ?? []
}

export default async function HistoricoCaixaPage() {
  const profile = await requirePageRole('gerente')
  const sessions = await getSessions(profile.company_id!)
  const closed   = sessions.filter((s) => s.status === 'closed')

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Wallet className="w-5 h-5 text-text-muted" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Histórico de Caixas</h2>
            <p className="text-sm text-text-muted">{closed.length} fechamentos</p>
          </div>
        </div>
        <Link href="/caixa">
          <Button variant="secondary" size="sm">← Caixa</Button>
        </Link>
      </div>

      <Card>
        {closed.length === 0 ? (
          <EmptyState
            icon={<Wallet className="w-6 h-6 text-text-muted" />}
            title="Nenhum caixa fechado ainda"
            description="O histórico aparece aqui após o primeiro fechamento."
          />
        ) : (
          <>
            <CardHeader>
              <p className="text-xs text-text-muted">Últimos {closed.length} fechamentos</p>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead align="right">Vendas</TableHead>
                  <TableHead align="right">Dinheiro</TableHead>
                  <TableHead align="right">PIX</TableHead>
                  <TableHead align="right">Cartão</TableHead>
                  <TableHead align="right">Diferença</TableHead>
                  <TableHead align="center">Detalhe</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {closed.map((s) => {
                  const diff = s.cash_difference ?? 0
                  // counted_cash = dinheiro físico contado ao fechar (o que estava na gaveta)
                  // total_cash   = soma das vendas pagas em dinheiro (detalhe na página interna)
                  const dinheiroFisico = s.counted_cash ?? s.expected_cash ?? 0
                  return (
                    <TableRow key={s.id}>
                      <TableCell muted>{formatDate(s.opened_at)}</TableCell>
                      <TableCell align="right" className="font-semibold text-text-primary tabular-nums">
                        {formatCurrency(s.total_sales ?? 0)}
                      </TableCell>
                      <TableCell align="right" className="tabular-nums text-text-secondary">
                        <span title={`Vendas em dinheiro: ${formatCurrency(s.total_cash ?? 0)}`}>
                          {formatCurrency(dinheiroFisico)}
                        </span>
                      </TableCell>
                      <TableCell align="right" className="tabular-nums text-text-secondary">
                        {formatCurrency(s.total_pix ?? 0)}
                      </TableCell>
                      <TableCell align="right" className="tabular-nums text-text-secondary">
                        {formatCurrency((s.total_credit_card ?? 0) + (s.total_debit_card ?? 0))}
                      </TableCell>
                      <TableCell align="right">
                        <Badge
                          variant={diff === 0 ? 'default' : diff > 0 ? 'success' : 'error'}
                          size="sm"
                        >
                          {diff > 0 ? '+' : ''}{formatCurrency(diff)}
                        </Badge>
                      </TableCell>
                      <TableCell align="center">
                        <Link href={`/caixa/historico/${s.id}`}>
                          <Button variant="ghost" size="sm" className="text-xs px-2">
                            <ChevronRight className="w-3.5 h-3.5" />
                          </Button>
                        </Link>
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
