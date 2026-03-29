'use client'

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
import { toISODate } from '@/lib/utils/date'

const ACTIVE_CATEGORIES: { value: string; label: string }[] = [
  { value: 'paid_traffic',        label: 'Tráfego Pago' },
  { value: 'content',             label: 'Conteúdo' },
  { value: 'design',              label: 'Design' },
  { value: 'photos',              label: 'Vídeo / Fotografia' },
  { value: 'influencers',         label: 'Influenciadores' },
  { value: 'tools',               label: 'Ferramentas de Marketing' },
  { value: 'crm_automation',      label: 'CRM / Automação' },
  { value: 'website_landing_page',label: 'Site / Landing Page' },
  { value: 'events',              label: 'Eventos / Ações Promocionais' },
  { value: 'gifts',               label: 'Impressos / Brindes' },
  { value: 'packaging',           label: 'Embalagem' },
  { value: 'agency_freelancer',   label: 'Agência / Freelancer' },
  { value: 'other',               label: 'Outras Despesas de Marketing' },
]

export default function NovoCustoMarketingPage() {
  const router = useRouter()

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<MarketingCostFormData>({
    resolver: zodResolver(marketingCostSchema),
    defaultValues: {
      cost_date: toISODate(new Date()),
      is_recurring: false,
    },
  })

  async function onSubmit(data: MarketingCostFormData) {
    const res = await fetch('/api/marketing/custos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, campaign_id: data.campaign_id || null, notes: data.notes || null }),
    })
    const json = await res.json()
    if (!res.ok) {
      toast.error('Erro ao registrar custo', { description: json.error })
      return
    }
    toast.success('Custo de marketing registrado!')
    router.refresh()
    router.push('/marketing')
  }

  return (
    <div className="max-w-xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/marketing">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Lançar Custo de Marketing</h2>
          <p className="text-sm text-text-muted">Registre um investimento em marketing</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="card p-6 space-y-5">
        {/* Categoria */}
        <Select
          label="Categoria"
          required
          error={errors.category?.message}
          {...register('category')}
        >
          <option value="">Selecione a categoria</option>
          {ACTIVE_CATEGORIES.map(({ value, label }) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </Select>

        {/* Descrição */}
        <Input
          label="Descrição"
          required
          placeholder="Ex: Impulsionamento Instagram — setembro"
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
            label="Data do custo"
            required
            type="date"
            error={errors.cost_date?.message}
            {...register('cost_date')}
          />
        </div>

        {/* Recorrente */}
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

        {/* Observações */}
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

        {/* Ações */}
        <div className="flex gap-3 pt-2">
          <Link href="/marketing" className="flex-1">
            <Button type="button" variant="secondary" className="w-full">
              Cancelar
            </Button>
          </Link>
          <Button type="submit" loading={isSubmitting} className="flex-1">
            Registrar Custo
          </Button>
        </div>
      </form>
    </div>
  )
}
