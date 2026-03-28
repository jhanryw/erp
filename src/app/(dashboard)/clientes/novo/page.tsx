'use client'

import Link from 'next/link'
import { useState, type ChangeEvent } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'

import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'

const customerFormSchema = z.object({
  name: z.string().min(2, 'Informe o nome'),
  cpf: z.string().length(11, 'CPF inválido'),
  phone: z.string().min(1, 'Informe o telefone'),
  birth_date: z.string().optional(),
  city: z.string().optional(),
  origin: z.string().optional(),
  notes: z.string().optional(),
})

type CustomerFormData = z.infer<typeof customerFormSchema>

export default function NovoClientePage() {
  const router = useRouter()
  const [cpfDisplay, setCpfDisplay] = useState('')

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<CustomerFormData>({
    resolver: zodResolver(customerFormSchema),
    defaultValues: {
      name: '',
      cpf: '',
      phone: '',
      birth_date: '',
      city: '',
      origin: '',
      notes: '',
    },
  })

  function handleCPFChange(e: ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value.replace(/\D/g, '').slice(0, 11)
    const formatted = raw
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4')

    setCpfDisplay(formatted)
    setValue('cpf', raw, {
      shouldValidate: true,
      shouldDirty: true,
      shouldTouch: true,
    })
  }

  async function onSubmit(data: CustomerFormData) {
    const payload = {
      ...data,
      birth_date: data.birth_date || '',
      city: data.city || '',
      origin: data.origin || '',
      notes: data.notes || '',
    }

    const res = await fetch('/api/clientes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const json = await res.json()

    if (!res.ok) {
      if (json.error === 'CPF já cadastrado.') {
        toast.error('CPF já cadastrado')
      } else {
        toast.error('Erro ao cadastrar cliente', {
          description:
            typeof json.error === 'string'
              ? json.error
              : 'Verifique os dados informados.',
        })
      }
      return
    }

    toast.success('Cliente cadastrado com sucesso!')
    router.push(`/clientes/${json.customer.id}`)
    router.refresh()
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-4">
        <Link href="/clientes">
          <Button type="button" variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Voltar
          </Button>
        </Link>

        <div>
          <h1 className="text-2xl font-semibold">Novo Cliente</h1>
          <p className="text-sm text-muted-foreground">
            Cadastre um novo cliente no sistema.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="grid max-w-2xl gap-4">
        <Input
          label="Nome"
          placeholder="Nome completo"
          {...register('name')}
          error={errors.name?.message}
          required
        />

        <Input
          label="CPF"
          placeholder="000.000.000-00"
          value={cpfDisplay}
          onChange={handleCPFChange}
          error={errors.cpf?.message}
          required
        />

        <Input
          label="Telefone"
          placeholder="(84) 99999-9999"
          {...register('phone')}
          error={errors.phone?.message}
          required
        />

        <Input
          label="Data de nascimento"
          type="date"
          {...register('birth_date')}
          error={errors.birth_date?.message}
        />

        <Input
          label="Cidade"
          placeholder="Natal"
          {...register('city')}
          error={errors.city?.message}
        />

        <Select
          label="Origem"
          {...register('origin')}
          error={errors.origin?.message}
        >
          <option value="">Não informado</option>
          <option value="instagram">Instagram</option>
          <option value="indicacao">Indicação</option>
          <option value="trafego_pago">Tráfego Pago</option>
          <option value="site">Site</option>
          <option value="loja_fisica">Loja Física</option>
          <option value="outro">Outro</option>
        </Select>

        <Input
          label="Observações"
          placeholder="Informações adicionais"
          {...register('notes')}
          error={errors.notes?.message}
        />

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