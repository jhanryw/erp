'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { toISODate, formatDateTime } from '@/lib/utils/date'
import { financeEntrySchema, type FinanceEntryFormData } from '@/lib/validators'
import { formatCurrency } from '@/lib/utils/currency'
import { safeReturnPath } from '../../_lib/safe-return'
import { AlertTriangle } from 'lucide-react'

type FinanceEntryForm = FinanceEntryFormData

type CashMovementInfo = {
  id: number
  description: string
  amount: number
  method: string
  created_at: string
  cancelled_at: string | null
  cancellation_reason: string | null
  metadata: Record<string, unknown> | null
}

type AuditHistoryEntry = {
  id: number
  ts: string
  action: string
  user_role: string | null
  before_data: Record<string, unknown> | null
  after_data: Record<string, unknown> | null
  detail: string | null
  users: { name: string } | null
}

const PAYMENT_METHODS = [
  { value: 'cash', label: 'Dinheiro' },
  { value: 'pix', label: 'PIX' },
  { value: 'credit_card', label: 'Crédito' },
  { value: 'debit_card', label: 'Débito' },
]

const INCOME_CATEGORIES = [
  { value: 'sale', label: 'Venda' },
  { value: 'cashback_used', label: 'Cashback Utilizado' },
  { value: 'other_income', label: 'Outra Receita' },
]

const EXPENSE_CATEGORIES = [
  { value: 'stock_purchase', label: 'Compra de Estoque' },
  { value: 'freight_cost', label: 'Frete' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'rent', label: 'Aluguel' },
  { value: 'salaries', label: 'Salários' },
  { value: 'operational', label: 'Operacional' },
  { value: 'taxes', label: 'Impostos' },
  { value: 'other_expense', label: 'Outra Despesa' },
]

export default function EditarLancamentoPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <EditarLancamentoForm params={params} />
    </Suspense>
  )
}

function EditarLancamentoForm({ params }: { params: { id: string } }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  // "from" preserva os filtros/página da listagem de onde o usuário veio —
  // sem isso, ele sempre voltaria para a primeira página sem filtros.
  // safeReturnPath rejeita qualquer coisa que não seja um caminho interno de
  // /financeiro/lancamentos, evitando um redirect aberto via link malicioso.
  const backTo = safeReturnPath(searchParams.get('from'))
  const [loading, setLoading] = useState(true)
  const [cashMovement, setCashMovement] = useState<CashMovementInfo | null>(null)
  const [auditHistory, setAuditHistory] = useState<AuditHistoryEntry[]>([])

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FinanceEntryForm>({
    resolver: zodResolver(financeEntrySchema),
  })

  const entryType = watch('type')
  const categories = entryType === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES

  useEffect(() => {
    fetch(`/api/financeiro/lancamentos/${params.id}`)
      .then(r => r.json())
      .then(({ entry, cashMovement, auditHistory, error }) => {
        if (error || !entry) {
          toast.error('Lançamento não encontrado')
          router.push(backTo)
          return
        }
        reset({
          type: entry.type,
          category: entry.category,
          description: entry.description,
          amount: entry.amount,
          reference_date: entry.reference_date,
          notes: entry.notes ?? '',
          // Registro antigo (payment_method/paid_at NULL): campos abrem vazios,
          // mas o schema exige preenchê-los para salvar se type = 'expense'.
          // paid_at é DATE: já vem como 'yyyy-MM-dd' pronto para o input,
          // sem nenhuma conversão de Date/timezone.
          payment_method: entry.payment_method ?? undefined,
          paid_at: entry.paid_at ?? undefined,
        })
        setCashMovement(cashMovement ?? null)
        setAuditHistory(auditHistory ?? [])
        setLoading(false)
      })
  }, [params.id, reset, router])

  async function onSubmit(data: FinanceEntryForm) {
    const res = await fetch(`/api/financeiro/lancamentos/${params.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        payment_method: data.payment_method || undefined,
        paid_at: data.paid_at || undefined,
      }),
    })
    const json = await res.json()
    if (!res.ok) {
      toast.error('Erro ao atualizar lançamento', { description: json.error })
      return
    }
    toast.success('Lançamento atualizado com sucesso!')
    router.refresh()
    router.push(backTo)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-text-muted">Carregando lançamento...</p>
      </div>
    )
  }

  return (
    <div className="max-w-xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href={backTo}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Editar Lançamento</h2>
          <p className="text-sm text-text-muted">Altere os dados do lançamento financeiro</p>
        </div>
      </div>

      {cashMovement && (
        <div className="card p-4 border-warning/30 bg-warning/5 space-y-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-warning">
                Este lançamento foi originado de um movimento do Caixa.
              </p>
              <p className="text-xs text-text-muted mt-0.5">
                Movimento de Caixa #{cashMovement.id}. Editar os campos abaixo atualiza somente este
                lançamento financeiro — o vínculo com o Caixa é preservado e o movimento original não é alterado.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <p className="text-text-muted">Descrição original</p>
              <p className="text-text-primary font-medium">{cashMovement.description}</p>
            </div>
            <div>
              <p className="text-text-muted">Valor original</p>
              <p className="text-text-primary font-medium">{formatCurrency(cashMovement.amount)}</p>
            </div>
            <div>
              <p className="text-text-muted">Método</p>
              <p className="text-text-primary font-medium">{cashMovement.method}</p>
            </div>
            <div>
              <p className="text-text-muted">Criado em</p>
              <p className="text-text-primary font-medium">{formatDateTime(cashMovement.created_at)}</p>
            </div>
            {cashMovement.cancelled_at && (
              <div className="col-span-2 sm:col-span-4">
                <p className="text-error font-medium">
                  Movimento cancelado em {formatDateTime(cashMovement.cancelled_at)}
                  {cashMovement.cancellation_reason && ` — ${cashMovement.cancellation_reason}`}
                </p>
              </div>
            )}
            {cashMovement.metadata && Object.keys(cashMovement.metadata).length > 0 && (
              <div className="col-span-2 sm:col-span-4">
                <p className="text-text-muted mb-1">Metadata</p>
                <pre className="text-[11px] bg-bg-overlay rounded p-2 overflow-x-auto">
                  {JSON.stringify(cashMovement.metadata, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="card p-6 space-y-5">
        <Select label="Tipo" required error={errors.type?.message} {...register('type')}>
          <option value="expense">Despesa</option>
          <option value="income">Receita</option>
        </Select>

        <Select label="Categoria" required error={errors.category?.message} {...register('category')}>
          <option value="">Selecione a categoria</option>
          {categories.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </Select>

        <Input
          label="Descrição"
          required
          placeholder="Ex: Compra de estoque fornecedor ABC"
          error={errors.description?.message}
          {...register('description')}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Valor (R$)"
            required
            type="number"
            step="0.01"
            min="0.01"
            placeholder="0,00"
            error={errors.amount?.message}
            {...register('amount')}
          />
          <Input
            label="Data de competência"
            required
            type="date"
            error={errors.reference_date?.message}
            {...register('reference_date')}
          />
        </div>

        {/* Forma e data de pagamento — obrigatórios juntos para despesa;
            para receita são opcionais (venda pode ficar pendente), mas nunca
            só um dos dois preenchido (financeEntrySchema barra isso).
            Registro antigo com pagamento nulo: campos abrem vazios, mas
            exigidos para salvar quando type='expense' (leitura nunca é
            bloqueada, só o submit). Mudar de recebido → pendente é só
            selecionar "Pendente" / limpar a data — nenhum campo fica
            escondido no estado do formulário. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select
            label="Forma de pagamento"
            required={entryType === 'expense'}
            placeholder={entryType === 'expense' ? 'Selecione' : undefined}
            hint={entryType === 'income' ? 'Deixe em branco se a venda ainda não foi recebida.' : undefined}
            error={errors.payment_method?.message}
            {...register('payment_method')}
          >
            {entryType === 'income' && <option value="">Pendente — ainda não recebida</option>}
            {PAYMENT_METHODS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </Select>
          <Input
            label="Data do recebimento/pagamento"
            required={entryType === 'expense'}
            type="date"
            max={toISODate(new Date())}
            error={errors.paid_at?.message}
            {...register('paid_at')}
          />
        </div>

        <div>
          <label className="label-base">
            Observações <span className="text-text-muted font-normal">(opcional)</span>
          </label>
          <textarea
            className="input-base resize-none"
            rows={3}
            placeholder="Detalhes adicionais..."
            {...register('notes')}
          />
        </div>

        <div className="flex gap-3 pt-2">
          <Link href={backTo} className="flex-1">
            <Button type="button" variant="secondary" className="w-full">
              Cancelar
            </Button>
          </Link>
          <Button type="submit" loading={isSubmitting} className="flex-1">
            Salvar Alterações
          </Button>
        </div>
      </form>

      {auditHistory.length > 0 && (
        <div className="card p-4 space-y-3">
          <p className="text-sm font-semibold text-text-primary">Histórico de alterações</p>
          <div className="space-y-2">
            {auditHistory.map((log) => (
              <div key={log.id} className="text-xs border-b border-border last:border-0 pb-2 last:pb-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-text-secondary">
                    {log.action === 'create' || log.action === 'link' ? 'Criação (regularização do Caixa)' : 'Alteração'}
                    {' · '}{log.users?.name ?? 'Sistema'}
                    {log.user_role && ` (${log.user_role})`}
                  </span>
                  <span className="text-text-muted whitespace-nowrap">{formatDateTime(log.ts)}</span>
                </div>
                {log.detail && <p className="text-text-muted mt-0.5">{log.detail}</p>}
                {(log.before_data || log.after_data) && (
                  <details className="mt-1">
                    <summary className="text-brand cursor-pointer">Ver valores</summary>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                      {log.before_data && (
                        <div>
                          <p className="text-text-muted mb-0.5">Antes</p>
                          <pre className="bg-bg-overlay rounded p-2 overflow-x-auto text-[11px]">
                            {JSON.stringify(log.before_data, null, 2)}
                          </pre>
                        </div>
                      )}
                      {log.after_data && (
                        <div>
                          <p className="text-text-muted mb-0.5">Depois</p>
                          <pre className="bg-bg-overlay rounded p-2 overflow-x-auto text-[11px]">
                            {JSON.stringify(log.after_data, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  </details>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
