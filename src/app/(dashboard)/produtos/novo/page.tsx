'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { productSchema, type ProductFormData } from '@/lib/validators'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'

export default function NovoProdutoPage() {
  const router = useRouter()
  const supabase = createClient()
  const [categories, setCategories] = useState<any[]>([])
  const [suppliers, setSuppliers] = useState<any[]>([])

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ProductFormData>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      origin: 'third_party',
      base_cost: 0,
      active: true,
    },
  })

  useEffect(() => {
    supabase.from('categories').select('id, name').eq('active', true).order('name')
      .then(({ data }) => setCategories(data ?? []))
    supabase.from('suppliers').select('id, name').eq('active', true).order('name')
      .then(({ data }) => setSuppliers(data ?? []))
  }, [])

  const baseCost = Number(watch('base_cost')) || 0
  const basePrice = Number(watch('base_price')) || 0
  const margin = basePrice > 0 ? ((basePrice - baseCost) / basePrice) * 100 : 0

  async function onSubmit(data: ProductFormData) {
    const { data: product, error } = await supabase
      .from('products')
      .insert({
        ...data,
        margin_pct: Math.round(margin * 100) / 100,
        supplier_id: data.supplier_id || null,
        subcategory_id: null,
        collection_id: null,
      } as any)
      .select('id')
      .single() as unknown as { data: { id: number } | null; error: any }

    if (error) {
      toast.error('Erro ao cadastrar produto', { description: error.message })
      return
    }

    toast.success('Produto cadastrado com sucesso!')
    router.push(`/produtos/${product!.id}`)
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/produtos">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Novo Produto</h2>
          <p className="text-sm text-text-muted">Preencha as informações do produto</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="card p-6 space-y-5">
        {/* Nome + SKU */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Nome do produto"
            required
            placeholder="Ex: Body de Renda Floral"
            error={errors.name?.message}
            {...register('name')}
          />
          <Input
            label="SKU"
            required
            placeholder="Ex: BODY-RD-001"
            error={errors.sku?.message}
            {...register('sku')}
          />
        </div>

        {/* Categoria + Fornecedor */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select
            label="Categoria"
            required
            error={errors.category_id?.message}
            {...register('category_id')}
          >
            <option value="">Selecione a categoria</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
          <Select label="Fornecedor" {...register('supplier_id')}>
            <option value="">Sem fornecedor</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
        </div>

        {/* Origem */}
        <Select label="Origem do produto" required {...register('origin')}>
          <option value="third_party">Terceiro (comprado de fornecedor)</option>
          <option value="own_brand">Marca Própria (produção interna)</option>
        </Select>

        {/* Custo / Preço / Margem */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Input
            label="Custo (R$)"
            type="number"
            step="0.01"
            min="0"
            placeholder="0,00"
            error={errors.base_cost?.message}
            {...register('base_cost')}
          />
          <Input
            label="Preço de Venda (R$)"
            required
            type="number"
            step="0.01"
            min="0.01"
            placeholder="0,00"
            error={errors.base_price?.message}
            {...register('base_price')}
          />
          <div>
            <label className="label-base">Margem calculada</label>
            <div
              className={`input-base pointer-events-none font-semibold ${
                margin >= 40
                  ? 'text-success'
                  : margin >= 25
                  ? 'text-warning'
                  : margin > 0
                  ? 'text-error'
                  : 'text-text-muted'
              }`}
            >
              {basePrice > 0 ? `${margin.toFixed(1)}%` : '—'}
            </div>
          </div>
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
            Produto ativo (visível nas vendas)
          </label>
        </div>

        {/* Ações */}
        <div className="flex gap-3 pt-2">
          <Link href="/produtos" className="flex-1">
            <Button type="button" variant="secondary" className="w-full">
              Cancelar
            </Button>
          </Link>
          <Button type="submit" loading={isSubmitting} className="flex-1">
            Cadastrar Produto
          </Button>
        </div>
      </form>
    </div>
  )
}
