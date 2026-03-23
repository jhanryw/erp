'use client'

import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { toISODate } from '@/lib/utils/date'

const financeEntrySchema = z.object({
  type: z.enum(['income', 'expense']),
  category: z.enum([
    'sale', 'cashback_used', 'other_income',
    'stock_purchase', 'freight_cost', 'marketing',
    'rent', 'salaries', 'operational', 'taxes', 'other_expense',
  ]),
  description: z.string().min(2, 'Descrição obrigatória'),
  amount: z.coerce.number().positive('Valor deve ser > 0'),
  reference_date: z.string().min(1, 'Data obrigatória'),
  notes: z.string().nullable().optional(),
})

type FinanceEntryForm = z.infer<typeof financeEntrySchema>

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
  const router = useRouter()

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FinanceEntryForm>({
    resolver: zodResolver(financeEntrySchema),
    defaultValues: {
      type: 'expense',
      reference_date: toISODate(new Date()),
    },
  })

  const entryType = watch('type')
  const categories = entryType === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES

  async function onSubmit(data: FinanceEntryForm) {
    const res = await fetch('/api/financeiro/lancamentos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, notes: data.notes || null }),
    })
    const json = await res.json()
    if (!res.ok) {
      toast.error('Erro ao registrar lançamento', { description: json.error })
      return
    }
    toast.success('Lançamento registrado com sucesso!')
    router.push('/financeiro')
  }

  return (
    <div className="max-w-xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/financeiro">
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
            label="Data de competência"
            required
            type="date"
            error={errors.reference_date?.message}
            {...register('reference_date')}
          />
        </div>

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
          <Link href="/financeiro" className="flex-1">
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
