import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { Plus, DollarSign } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import { DeleteEntryButton } from './_components/delete-entry-button'

const CATEGORY_LABELS: Record<string, string> = {
  sale: 'Venda',
  cashback_used: 'Cashback Utilizado',
  other_income: 'Outra Receita',
  stock_purchase: 'Compra de Estoque',
  freight_cost: 'Frete',
  marketing: 'Marketing',
  rent: 'Aluguel',
  salaries: 'Salários',
  operational: 'Operacional',
  taxes: 'Impostos',
  other_expense: 'Outra Despesa',
}

async function getEntries() {
  const supabase = createClient()
  const { data } = await supabase
    .from('finance_entries')
    .select('id, type, category, description, amount, reference_date, notes')
    .order('reference_date', { ascending: false })
    .limit(100) as unknown as { data: any[] | null }
  return data ?? []
}

export default async function LancamentosPage() {
  const entries = await getEntries()

  const totalIncome = entries.filter(e => e.type === 'income').reduce((s, e) => s + e.amount, 0)
  const totalExpense = entries.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Lançamentos Financeiros</h2>
          <p className="text-sm text-text-muted">{entries.length} lançamentos</p>
        </div>
        <div className="flex gap-2">
          <Link href="/financeiro">
            <Button variant="secondary" size="sm">← Financeiro</Button>
          </Link>
          <Link href="/financeiro/lancamentos/novo">
            <Button size="sm">
              <Plus className="w-4 h-4" />
              Novo Lançamento
            </Button>
          </Link>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-4">
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Total de Receitas</p>
          <p className="text-xl font-bold text-success">{formatCurrency(totalIncome)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Total de Despesas</p>
          <p className="text-xl font-bold text-error">{formatCurrency(totalExpense)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Saldo</p>
          <p className={`text-xl font-bold ${totalIncome - totalExpense >= 0 ? 'text-success' : 'text-error'}`}>
            {formatCurrency(totalIncome - totalExpense)}
          </p>
        </div>
      </div>

      <Card>
        {entries.length === 0 ? (
          <EmptyState
            icon={<DollarSign className="w-6 h-6 text-text-muted" />}
            title="Nenhum lançamento registrado"
            description="Registre receitas e despesas para controle financeiro."
            action={{ label: 'Novo Lançamento', href: '/financeiro/lancamentos/novo' }}
          />
        ) : (
          <>
            <CardHeader>
              <p className="text-xs text-text-muted">{entries.length} lançamentos (últimos 100)</p>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead>Descrição</TableHead>
                  <TableHead align="right">Valor</TableHead>
                  <TableHead align="center">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell muted>{formatDate(entry.reference_date)}</TableCell>
                    <TableCell>
                      <Badge variant={entry.type === 'income' ? 'success' : 'error'} size="sm">
                        {entry.type === 'income' ? 'Receita' : 'Despesa'}
                      </Badge>
                    </TableCell>
                    <TableCell muted>{CATEGORY_LABELS[entry.category] ?? entry.category}</TableCell>
                    <TableCell className="max-w-xs">
                      <span className="truncate block">{entry.description}</span>
                    </TableCell>
                    <TableCell align="right">
                      <span className={`font-semibold ${entry.type === 'income' ? 'text-success' : 'text-error'}`}>
                        {entry.type === 'income' ? '+' : '−'} {formatCurrency(entry.amount)}
                      </span>
                    </TableCell>
                    <TableCell align="center">
                      <div className="flex items-center justify-center gap-1">
                        <Link href={`/financeiro/lancamentos/${entry.id}/editar`}>
                          <Button variant="ghost" size="sm" className="text-xs px-2">Editar</Button>
                        </Link>
                        <DeleteEntryButton id={entry.id} />
                      </div>
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
