'use client'

import { useEffect, useState } from 'react'
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

const schema = z.object({
  name: z.string().min(2, 'Nome obrigatório'),
  phone: z.string().min(1, 'Telefone obrigatório'),
  birth_date: z.string().optional(),
  city: z.string().optional(),
  state: z.string().max(2).optional(),
  origin: z.string().optional(),
  notes: z.string().optional(),
  active: z.boolean().default(true),
})

type FormData = z.infer<typeof schema>

export default function EditarClientePage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
  })

  useEffect(() => {
    fetch(`/api/clientes/${params.id}`)
      .then(r => r.json())
      .then(({ customer, error }) => {
        if (error || !customer) {
          toast.error('Cliente não encontrado')
          router.push('/clientes')
          return
        }
        reset({
          name: customer.name ?? '',
          phone: customer.phone ?? '',
          birth_date: customer.birth_date ?? '',
          city: customer.city ?? '',
          state: customer.state ?? '',
          origin: customer.origin ?? '',
          notes: customer.notes ?? '',
          active: customer.active ?? true,
        })
        setLoading(false)
      })
  }, [params.id, reset, router])

  async function onSubmit(data: FormData) {
    const res = await fetch(`/api/clientes/${params.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    const json = await res.json()
    if (!res.ok) {
      toast.error('Erro ao atualizar cliente', { description: json.error })
      return
    }
    toast.success('Cliente atualizado!')
    router.refresh()
    router.push(`/clientes/${params.id}`)
  }

  if (loading) {
    return <div className="flex items-center justify-center py-16"><p className="text-sm text-text-muted">Carregando cliente...</p></div>
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href={`/clientes/${params.id}`}>
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Editar Cliente</h2>
          <p className="text-sm text-text-muted">Altere os dados da cliente</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="card p-6 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Nome completo" required placeholder="Nome da cliente" error={errors.name?.message} {...register('name')} />
          <Input label="Telefone / WhatsApp" required placeholder="(84) 99999-9999" error={errors.phone?.message} {...register('phone')} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Input label="Data de nascimento" type="date" error={errors.birth_date?.message} {...register('birth_date')} />
          <Input label="Cidade" placeholder="Natal" {...register('city')} />
          <Input label="Estado (UF)" placeholder="RN" maxLength={2} error={errors.state?.message} {...register('state')} />
        </div>

        <Select label="Origem" {...register('origin')}>
          <option value="">Não informado</option>
          <option value="instagram">Instagram</option>
          <option value="referral">Indicação</option>
          <option value="paid_traffic">Tráfego Pago</option>
          <option value="website">Site</option>
          <option value="store">Loja Física</option>
          <option value="other">Outro</option>
        </Select>

        <div>
          <label className="label-base">Observações</label>
          <textarea className="input-base resize-none" rows={3} placeholder="Informações adicionais..." {...register('notes')} />
        </div>

        <div className="flex items-center gap-3">
          <input type="checkbox" id="active" className="w-4 h-4 rounded border-border bg-bg-input accent-brand" {...register('active')} />
          <label htmlFor="active" className="text-sm text-text-primary cursor-pointer">Cliente ativa</label>
        </div>

        <div className="flex gap-3 pt-2">
          <Link href={`/clientes/${params.id}`} className="flex-1">
            <Button type="button" variant="secondary" className="w-full">Cancelar</Button>
          </Link>
          <Button type="submit" loading={isSubmitting} className="flex-1">Salvar Alterações</Button>
        </div>
      </form>
    </div>
  )
}
