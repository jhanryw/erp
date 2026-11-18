'use client'

import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { toISODate } from '@/lib/utils/date'
import { financeEntrySchema, type FinanceEntryFormData } from '@/lib/validators'
import { safeReturnPath } from '../_lib/safe-return'

type FinanceEntryForm = FinanceEntryFormData

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

export default function NovoLancamentoPage() {
  return (
    <Suspense>
      <NovoLancamentoForm />
    </Suspense>
  )
}

function NovoLancamentoForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  // "from" preserva os filtros/página da listagem de onde o usuário veio —
  // sem isso, ele sempre voltaria para a primeira página sem filtros.
  // safeReturnPath rejeita qualquer coisa que não seja um caminho interno de
  // /financeiro/lancamentos, evitando um redirect aberto via link malicioso.
  const backTo = safeReturnPath(searchParams.get('from'))

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FinanceEntryForm>({
    resolver: zodResolver(financeEntrySchema),
    defaultValues: {
      type: 'expense',
      payment_status: 'pending',
      reference_date: toISODate(new Date()),
    },
  })

  const entryType = watch('type')
  const status = watch('payment_status')
  const isLegacy = false
  const categories = entryType === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES

  // Receita não tem agendamento: ao trocar para receita, volta a Pendente.
  useEffect(() => {
    if (entryType === 'income' && status === 'scheduled') setValue('payment_status', 'pending')
  }, [entryType, status, setValue])

  // Pendente nunca carrega forma/data de pagamento.
  useEffect(() => {
    if (status === 'pending') {
      setValue('payment_method', undefined)
      setValue('paid_at', undefined)
    }
  }, [status, setValue])

  async function onSubmit(data: FinanceEntryForm) {
    const res = await fetch('/api/financeiro/lancamentos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        notes: data.notes || null,
        payment_status: data.payment_status || 'pending',
        payment_method: data.payment_method || undefined,
        paid_at: data.paid_at || undefined,
      }),
    })
    const json = await res.json()
    if (!res.ok) {
      toast.error('Erro ao registrar lançamento', { description: json.error })
      return
    }
    toast.success('Lançamento registrado com sucesso!')
    router.refresh()
    router.push(backTo)
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
          <h2 className="text-lg font-semibold text-text-primary">Novo Lançamento</h2>
          <p className="text-sm text-text-muted">Registre uma receita ou despesa</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="card p-6 space-y-5">
        {/* Tipo */}
        <Select label="Tipo" required error={errors.type?.message} {...register('type')}>
          <option value="expense">Despesa</option>
          <option value="income">Receita</option>
        </Select>

        {/* Categoria */}
        <Select
          label="Categoria"
          required
          error={errors.category?.message}
          {...register('category')}
        >
          <option value="">Selecione a categoria</option>
          {categories.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </Select>

        {/* Descrição */}
        <Input
          label="Descrição"
          required
          placeholder="Ex: Compra de estoque fornecedor ABC"
          error={errors.description?.message}
          {...register('description')}
        />

        {/* Valor + Data */}
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
            label="Vencimento / competência"
            hint="Pode ser data futura (conta a pagar/receber)."
            required
            type="date"
            error={errors.reference_date?.message}
            {...register('reference_date')}
          />
        </div>

        {/* Situação do pagamento: Pendente (sem pagamento), Agendado (programado
            no banco, ainda não confirmado — só despesa) ou Pago (efetivado). */}
        <Select
          label="Situação do pagamento"
          hint="Agendado = programado no banco para uma data, ainda não confirmado. Não vira Pago sozinho."
          error={errors.payment_status?.message}
          {...register('payment_status')}
        >
          <option value="pending">{entryType === 'income' ? 'Pendente — ainda não recebida' : 'Pendente — ainda não paga'}</option>
          {entryType === 'expense' && <option value="scheduled">Agendado — programado no banco</option>}
          <option value="paid">{entryType === 'income' ? 'Recebido' : 'Pago'}</option>
        </Select>

        {status !== 'pending' && !(isLegacy && !status) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Forma de pagamento"
              required
              error={errors.payment_method?.message}
              {...register('payment_method')}
            >
              <option value="">Selecione</option>
              {PAYMENT_METHODS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </Select>
            <Input
              label={status === 'scheduled' ? 'Data programada do pagamento' : entryType === 'income' ? 'Data do recebimento' : 'Data do pagamento'}
              hint={status === 'scheduled' ? 'Data em que o banco fará o pagamento. Pode ser futura.' : 'Data em que o pagamento foi efetivado. Não pode ser futura.'}
              required
              type="date"
              {...(status === 'scheduled' ? { min: toISODate(new Date()) } : { max: toISODate(new Date()) })}
              error={errors.paid_at?.message}
              {...register('paid_at')}
            />
          </div>
        )}

        {/* Observações */}
        <div>
          <label className="label-base">Observações <span className="text-text-muted font-normal">(opcional)</span></label>
          <textarea
            className="input-base resize-none"
            rows={3}
            placeholder="Detalhes adicionais..."
            {...register('notes')}
          />
        </div>

        {/* Ações */}
        <div className="flex gap-3 pt-2">
          <Link href={backTo} className="flex-1">
            <Button type="button" variant="secondary" className="w-full">
              Cancelar
            </Button>
          </Link>
          <Button type="submit" loading={isSubmitting} className="flex-1">
            Registrar Lançamento
          </Button>
        </div>
      </form>
    </div>
  )
}
