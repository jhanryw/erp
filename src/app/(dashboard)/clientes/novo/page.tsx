'use client'

import { useRouter } from 'next/navigation'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { customerSchema, type CustomerFormData } from '@/lib/validators'
import { formatCPF } from '@/lib/utils/cpf'
import { useAuth } from '@/hooks/useAuth'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { useState } from 'react'

export default function NovoClientePage() {
  const router = useRouter()
  const { user } = useAuth()
  const supabase = createClient()
  const [cpfDisplay, setCpfDisplay] = useState('')

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<CustomerFormData>({
    resolver: zodResolver(customerSchema),
  })

  async function onSubmit(data: CustomerFormData) {
    if (!user) return

    const { data: customer, error } = await supabase
      .from('customers')
      .insert({ ...data, created_by: user.id })
      .select('id')
      .single()

    if (error) {
      if (error.code === '23505') {
        toast.error('CPF já cadastrado')
      } else {
        toast.error('Erro ao cadastrar cliente', { description: error.message })
      }
      return
    }

    toast.success('Cliente cadastrado com sucesso!')
    router.push(`/clientes/${customer.id}`)
  }

  function handleCPFChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.replace(/\D/g, '').slice(0, 11)
    const formatted = raw
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4')
    setCpfDisplay(formatted)
    setValue('cpf', raw)
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/clientes">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <h2 className="text-lg font-semibold text-text-primary">Novo Cliente</h2>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="card p-6 space-y-5">
        {/* CPF */}
        <div>
          <Input
            label="CPF"
            required
            value={cpfDisplay}
            onChange={handleCPFChange}
            placeholder="000.000.000-00"
            error={errors.cpf?.message}
            hint="O CPF é validado automaticamente"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Nome completo"
            required
            placeholder="Nome da cliente"
            error={errors.name?.message}
            {...register('name')}
          />
          <Input
            label="Telefone / WhatsApp"
            required
            placeholder="(84) 99999-9999"
            error={errors.phone?.message}
            {...register('phone')}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Data de nascimento"
            type="date"
            error={errors.birth_date?.message}
            {...register('birth_date')}
          />
          <Input
            label="Cidade"
            placeholder="Natal"
            {...register('city')}
          />
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
          <textarea
            className="input-base resize-none"
            rows={3}
            placeholder="Informações adicionais..."
            {...register('notes')}
          />
        </div>

        <div className="flex gap-3 pt-2">
          <Link href="/clientes" className="flex-1">
            <Button type="button" variant="secondary" className="w-full">
              Cancelar
            </Button>
          </Link>
          <Button type="submit" loading={isSubmitting} className="flex-1">
            Cadastrar Cliente
          </Button>
        </div>
      </form>
    </div>
  )
}
