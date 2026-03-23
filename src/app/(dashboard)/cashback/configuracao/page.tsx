'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { ArrowLeft, Gift } from 'lucide-react'
import Link from 'next/link'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

const schema = z.object({
  rate_pct: z.coerce.number().min(0.01, 'Mínimo 0,01%').max(100, 'Máximo 100%'),
  min_order_value: z.coerce.number().min(0, 'Valor inválido'),
  release_days: z.coerce.number().int().min(0, 'Valor inválido'),
  expiry_days: z.coerce.number().int().min(1, 'Mínimo 1 dia'),
  min_use_value: z.coerce.number().min(0, 'Valor inválido'),
})

type FormData = z.infer<typeof schema>

export default function CashbackConfiguracaoPage() {
  const router = useRouter()
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      rate_pct: 5,
      min_order_value: 0,
      release_days: 30,
      expiry_days: 180,
      min_use_value: 10,
    },
  })

  useEffect(() => {
    fetch('/api/cashback')
      .then(r => r.json())
      .then(({ config }) => {
        if (config) reset({
          rate_pct: config.rate_pct,
          min_order_value: config.min_order_value,
          release_days: config.release_days,
          expiry_days: config.expiry_days,
          min_use_value: config.min_use_value,
        })
      })
  }, [reset])

  async function onSubmit(data: FormData) {
    const res = await fetch('/api/cashback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, active: true }),
    })
    const json = await res.json()
    if (!res.ok) {
      toast.error('Erro ao salvar configuração', { description: json.error })
      return
    }
    toast.success('Configuração salva com sucesso!')
    router.push('/cashback')
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/cashback">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div className="flex items-center gap-2">
          <Gift className="w-5 h-5 text-brand" />
          <h2 className="text-lg font-semibold text-text-primary">Configurar Cashback</h2>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="card p-6 space-y-5">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-text-primary">Regras do Programa</h3>
          <p className="text-xs text-text-muted">Define como o cashback é acumulado e utilizado pelas clientes.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Percentual de cashback (%)"
            type="number"
            step="0.01"
            required
            placeholder="5"
            hint="Ex: 5 = 5% do valor da compra"
            error={errors.rate_pct?.message}
            {...register('rate_pct')}
          />
          <Input
            label="Pedido mínimo para ganhar (R$)"
            type="number"
            step="0.01"
            required
            placeholder="0"
            hint="0 = qualquer valor"
            error={errors.min_order_value?.message}
            {...register('min_order_value')}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Dias para liberar"
            type="number"
            required
            placeholder="30"
            hint="Dias após a compra até o cashback ficar disponível"
            error={errors.release_days?.message}
            {...register('release_days')}
          />
          <Input
            label="Dias até expirar"
            type="number"
            required
            placeholder="180"
            hint="Dias até o cashback disponível expirar"
            error={errors.expiry_days?.message}
            {...register('expiry_days')}
          />
        </div>

        <Input
          label="Valor mínimo para usar (R$)"
          type="number"
          step="0.01"
          required
          placeholder="10"
          hint="Saldo mínimo necessário para usar o cashback em uma compra"
          error={errors.min_use_value?.message}
          {...register('min_use_value')}
        />

        <div className="flex gap-3 pt-2">
          <Link href="/cashback" className="flex-1">
            <Button type="button" variant="secondary" className="w-full">Cancelar</Button>
          </Link>
          <Button type="submit" loading={isSubmitting} className="flex-1">
            Salvar Configuração
          </Button>
        </div>
      </form>
    </div>
  )
}
