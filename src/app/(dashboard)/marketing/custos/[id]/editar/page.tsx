'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { marketingCostSchema, type MarketingCostFormData } from '@/lib/validators'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'

const CATEGORY_LABELS: Record<string, string> = {
  paid_traffic: 'Tráfego Pago',
  influencers: 'Influenciadores',
  events: 'Eventos',
  photos: 'Fotos / Conteúdo',
  gifts: 'Brindes',
  packaging: 'Embalagens',
  rent: 'Aluguel',
  salaries: 'Salários',
  operational: 'Operacional',
  taxes: 'Impostos',
  other: 'Outros',
}

export default function EditarCustoMarketingPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<MarketingCostFormData>({
    resolver: zodResolver(marketingCostSchema),
  })

  useEffect(() => {
    fetch(`/api/marketing/custos/${params.id}`)
      .then(r => r.json())
      .then(({ cost, error }) => {
        if (error || !cost) {
          toast.error('Custo não encontrado')
          router.push('/marketing/custos')
          return
        }
        reset({
          category: cost.category,
          description: cost.description,
          amount: cost.amount,
          cost_date: cost.cost_date,
          is_recurring: cost.is_recurring ?? false,
          campaign_id: cost.campaign_id ?? undefined,
          notes: cost.notes ?? '',
        })
        setLoading(false)
      })
  }, [params.id, reset, router])

  async function onSubmit(data: MarketingCostFormData) {
    const res = await fetch(`/api/marketing/custos/${params.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, campaign_id: data.campaign_id || null, notes: data.notes || null }),
    })
    const json = await res.json()
    if (!res.ok) {
      toast.error('Erro ao atualizar custo', { description: json.error })
      return
    }
    toast.success('Custo de marketing atualizado!')
    router.push('/marketing/custos')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-text-muted">Carregando custo...</p>
      </div>
    )
  }

  return (
    <div className="max-w-xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/marketing/custos">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Editar Custo de Marketing</h2>
          <p className="text-sm text-text-muted">Altere os dados do investimento</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="card p-6 space-y-5">
        <Select label="Categoria" required error={errors.category?.message} {...register('category')}>
          <option value="">Selecione a categoria</option>
          {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </Select>

        <Input
          label="Descrição"
          required
          placeholder="Ex: Impulsionamento Instagram — setembro"
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
            label="Data do custo"
            required
            type="date"
            error={errors.cost_date?.message}
            {...register('cost_date')}
          />
        </div>

        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="is_recurring"
            className="w-4 h-4 rounded border-border bg-bg-input accent-brand"
            {...register('is_recurring')}
          />
          <label htmlFor="is_recurring" className="text-sm text-text-primary cursor-pointer">
            Custo recorrente (mensal)
          </label>
        </div>

        <div>
          <label className="label-base">
            Observações <span className="text-text-muted font-normal">(opcional)</span>
          </label>
          <textarea
            className="input-base resize-none"
            rows={3}
            placeholder="Detalhes sobre este investimento..."
            {...register('notes')}
          />
        </div>

        <div className="flex gap-3 pt-2">
          <Link href="/marketing/custos" className="flex-1">
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
