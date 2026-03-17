'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'

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

export default function EditarLancamentoPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)

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
    const supabase = createClient()
    supabase
      .from('finance_entries')
      .select('*')
      .eq('id', Number(params.id))
      .single()
      .then(({ data: raw, error }) => {
        const data = raw as any
        if (error || !data) {
          toast.error('Lançamento não encontrado')
          router.push('/financeiro/lancamentos')
          return
        }
        reset({
          type: data.type,
          category: data.category,
          description: data.description,
          amount: data.amount,
          reference_date: data.reference_date,
          notes: data.notes ?? '',
        })
        setLoading(false)
      })
  }, [params.id, reset, router])

  async function onSubmit(data: FinanceEntryForm) {
    const supabase = createClient()
    const { error } = await (supabase as any)
      .from('finance_entries')
      .update({
        type: data.type,
        category: data.category,
        description: data.description,
        amount: data.amount,
        reference_date: data.reference_date,
        notes: data.notes || null,
      })
      .eq('id', Number(params.id))

    if (error) {
      toast.error('Erro ao atualizar lançamento', { description: error.message })
      return
    }

    toast.success('Lançamento atualizado com sucesso!')
    router.push('/financeiro/lancamentos')
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
        <Link href="/financeiro/lancamentos">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Editar Lançamento</h2>
          <p className="text-sm text-text-muted">Altere os dados do lançamento financeiro</p>
        </div>
      </div>

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
          <Link href="/financeiro/lancamentos" className="flex-1">
            <Button type="button" variant="secondary" className="w-full">
              Cancelar
            </Button>
          </Link>
          <Button type="submit" loading={isSubmitting} className="flex-1">
            Salvar Alterações
          </Button>
        </div>
      </form>
    </div>
  )
}
