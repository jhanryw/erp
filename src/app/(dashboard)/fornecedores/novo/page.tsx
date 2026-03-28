'use client'

import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { supplierSchema, type SupplierFormData } from '@/lib/validators'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

const BRAZIL_STATES = [
  'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA',
  'MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN',
  'RS','RO','RR','SC','SP','SE','TO',
]

export default function NovoFornecedorPage() {
  const router = useRouter()

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SupplierFormData>({
    resolver: zodResolver(supplierSchema),
    defaultValues: { active: true },
  })

  async function onSubmit(data: SupplierFormData) {
    const res = await fetch('/api/fornecedores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    const json = await res.json()
    if (!res.ok) {
      toast.error('Erro ao cadastrar fornecedor', { description: json.error })
      return
    }
    toast.success('Fornecedor cadastrado com sucesso!')
    router.push(`/fornecedores/${json.supplier.id}`)
    router.refresh()
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/fornecedores">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Novo Fornecedor</h2>
          <p className="text-sm text-text-muted">Preencha os dados do fornecedor</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="card p-6 space-y-5">
        {/* Nome */}
        <Input
          label="Nome / Razão Social"
          required
          placeholder="Ex: Fábrica de Lingerie ABC Ltda"
          error={errors.name?.message}
          {...register('name')}
        />

        {/* Documento + Telefone */}
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

        {/* Cidade + UF */}
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
            {errors.state && (
              <p className="mt-1 text-xs text-error">{errors.state.message}</p>
            )}
          </div>
        </div>

        {/* Observações */}
        <div>
          <label className="label-base">Observações</label>
          <textarea
            className="input-base resize-none"
            rows={3}
            placeholder="Prazo de entrega, condições de pagamento, etc."
            {...register('notes')}
          />
        </div>

        {/* Ativo */}
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="active"
            defaultChecked
            className="w-4 h-4 rounded border-border bg-bg-input accent-brand"
            {...register('active')}
          />
          <label htmlFor="active" className="text-sm text-text-primary cursor-pointer">
            Fornecedor ativo
          </label>
        </div>

        {/* Ações */}
        <div className="flex gap-3 pt-2">
          <Link href="/fornecedores" className="flex-1">
            <Button type="button" variant="secondary" className="w-full">
              Cancelar
            </Button>
          </Link>
          <Button type="submit" loading={isSubmitting} className="flex-1">
            Cadastrar Fornecedor
          </Button>
        </div>
      </form>
    </div>
  )
}
