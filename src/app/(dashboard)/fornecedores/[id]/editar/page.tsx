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
import { Button } from '@/components/ui/button'

const BRAZIL_STATES = [
  'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA',
  'MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN',
  'RS','RO','RR','SC','SP','SE','TO',
]

// Schema local que aceita estado vazio (transforma "" → null)
const supplierEditSchema = z.object({
  name: z.string().min(2, 'Nome obrigatório'),
  document: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().optional().transform((v) => (v && v.length === 2 ? v : null)),
  notes: z.string().nullable().optional(),
  active: z.boolean().default(true),
})

type SupplierEditForm = z.infer<typeof supplierEditSchema>

export default function EditarFornecedorPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<SupplierEditForm>({
    resolver: zodResolver(supplierEditSchema),
  })

  useEffect(() => {
    const supabase = createClient()
    supabase
      .from('suppliers')
      .select('*')
      .eq('id', Number(params.id))
      .single()
      .then(({ data: raw, error }) => {
        const data = raw as any
        if (error || !data) {
          toast.error('Fornecedor não encontrado')
          router.push('/fornecedores')
          return
        }
        reset({
          name: data.name,
          document: data.document ?? '',
          phone: data.phone ?? '',
          city: data.city ?? '',
          state: data.state ?? '',
          notes: data.notes ?? '',
          active: data.active ?? true,
        })
        setLoading(false)
      })
  }, [params.id, reset, router])

  async function onSubmit(data: SupplierEditForm) {
    const supabase = createClient()
    const { error } = await (supabase as any)
      .from('suppliers')
      .update({
        name: data.name,
        document: data.document || null,
        phone: data.phone || null,
        city: data.city || null,
        state: data.state || null,
        notes: data.notes || null,
        active: data.active,
      })
      .eq('id', Number(params.id))

    if (error) {
      toast.error('Erro ao atualizar fornecedor', { description: error.message })
      return
    }

    toast.success('Fornecedor atualizado!')
    router.push(`/fornecedores/${params.id}`)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-text-muted">Carregando fornecedor...</p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href={`/fornecedores/${params.id}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Editar Fornecedor</h2>
          <p className="text-sm text-text-muted">Altere os dados do fornecedor</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="card p-6 space-y-5">
        <Input
          label="Nome / Razão Social"
          required
          placeholder="Ex: Fábrica de Lingerie ABC Ltda"
          error={errors.name?.message}
          {...register('name')}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="CPF / CNPJ"
            placeholder="000.000.000-00 ou 00.000.000/0001-00"
            error={errors.document?.message}
            {...register('document')}
          />
          <Input
            label="Telefone / WhatsApp"
            placeholder="(11) 99999-9999"
            error={errors.phone?.message}
            {...register('phone')}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="sm:col-span-2">
            <Input
              label="Cidade"
              placeholder="Ex: São Paulo"
              error={errors.city?.message}
              {...register('city')}
            />
          </div>
          <div>
            <label className="label-base">UF</label>
            <select className="input-base" {...register('state')}>
              <option value="">—</option>
              {BRAZIL_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="label-base">Observações</label>
          <textarea
            className="input-base resize-none"
            rows={3}
            placeholder="Prazo de entrega, condições de pagamento, etc."
            {...register('notes')}
          />
        </div>

        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="active"
            className="w-4 h-4 rounded border-border bg-bg-input accent-brand"
            {...register('active')}
          />
          <label htmlFor="active" className="text-sm text-text-primary cursor-pointer">
            Fornecedor ativo
          </label>
        </div>

        <div className="flex gap-3 pt-2">
          <Link href={`/fornecedores/${params.id}`} className="flex-1">
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
