'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'

import { productEditSchema, type ProductEditFormData } from '@/lib/validators'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'

type Category = {
  id: number
  name: string
}

type Supplier = {
  id: number
  name: string
}

type ProductApiResponse = {
  product?: {
    id: number
    name: string
    sku: string
    category_id: number
    supplier_id: number | null
    origin: 'own_brand' | 'third_party'
    base_cost: number
    base_price: number
    active: boolean
  }
  error?: string
}

export default function EditarProdutoPage({
  params,
}: {
  params: { id: string }
}) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [categories, setCategories] = useState<Category[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ProductEditFormData>({
    resolver: zodResolver(productEditSchema),
  })

  const baseCost = Number(watch('base_cost')) || 0
  const basePrice = Number(watch('base_price')) || 0
  const margin =
    basePrice > 0 ? ((basePrice - baseCost) / basePrice) * 100 : 0

  useEffect(() => {
    async function load() {
      try {
        const [catsRes, supsRes, productRes] = await Promise.all([
          fetch('/api/categorias'),
          fetch('/api/fornecedores'),
          fetch(`/api/produtos/${params.id}`),
        ])

        const catsJson = await catsRes.json()
        const supsJson = await supsRes.json()
        const productJson: ProductApiResponse = await productRes.json()

        setCategories(catsJson.categories ?? [])
        setSuppliers(supsJson.suppliers ?? [])

        if (!productRes.ok || !productJson.product) {
          toast.error('Produto não encontrado')
          router.push('/produtos')
          return
        }

        const product = productJson.product

        reset({
          name: product.name ?? '',
          sku: product.sku ?? '',
          category_id: Number(product.category_id),
          supplier_id:
            product.supplier_id !== null && product.supplier_id !== undefined
              ? Number(product.supplier_id)
              : undefined,
          origin: product.origin ?? 'third_party',
          base_cost: Number(product.base_cost ?? 0),
          base_price: Number(product.base_price ?? 0),
          active: Boolean(product.active),
        })
      } catch {
        toast.error('Erro ao carregar produto')
        router.push('/produtos')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [params.id, reset, router])

  async function onSubmit(data: ProductEditFormData) {
    // Montar payload sem campos undefined (PUT parcial — backend faz merge com o banco)
    const payload: Record<string, unknown> = {}
    if (data.name        !== undefined) payload.name        = data.name
    if (data.sku         !== undefined) payload.sku         = data.sku
    if (data.category_id !== undefined) payload.category_id = Number(data.category_id)
    if (data.origin      !== undefined) payload.origin      = data.origin
    if (data.base_cost   !== undefined) payload.base_cost   = Number(data.base_cost)
    if (data.base_price  !== undefined) payload.base_price  = Number(data.base_price)
    if (data.active      !== undefined) payload.active      = data.active
    // supplier_id: null é intencional (remover fornecedor), undefined = não enviado
    if ('supplier_id' in data) payload.supplier_id = data.supplier_id ? Number(data.supplier_id) : null

    try {
      const res = await fetch(`/api/produtos/${params.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const json = await res.json()

      if (!res.ok) {
        toast.error('Erro ao atualizar produto', {
          description:
            typeof json.error === 'string'
              ? json.error
              : 'Não foi possível salvar as alterações.',
        })
        return
      }

      toast.success('Produto atualizado com sucesso!')
      router.push(`/produtos/${params.id}`)
      router.refresh()
    } catch {
      toast.error('Erro ao atualizar produto', {
        description: 'Falha de comunicação com o servidor.',
      })
    }
  }

  if (loading) {
    return <div className="p-6">Carregando produto...</div>
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-4">
        <Link href={`/produtos/${params.id}`}>
          <Button type="button" variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Voltar
          </Button>
        </Link>

        <div>
          <h1 className="text-2xl font-semibold">Editar Produto</h1>
          <p className="text-sm text-muted-foreground">
            Altere as informações do produto
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="grid max-w-2xl gap-4">
        <Input
          label="Nome"
          {...register('name')}
          error={errors.name?.message}
        />

        <Input
          label="SKU"
          {...register('sku')}
          error={errors.sku?.message}
        />

        <Select
          label="Categoria"
          {...register('category_id', { valueAsNumber: true })}
          error={errors.category_id?.message}
        >
          <option value="">Selecione a categoria</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>

        <Select
          label="Fornecedor"
          {...register('supplier_id')}
          error={errors.supplier_id?.message as string | undefined}
        >
          <option value="">Sem fornecedor</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>

        <Select
          label="Origem"
          {...register('origin')}
          error={errors.origin?.message}
        >
          <option value="third_party">Terceiro</option>
          <option value="own_brand">Marca Própria</option>
        </Select>

        <Input
          label="Custo base"
          type="number"
          step="0.01"
          {...register('base_cost', { valueAsNumber: true })}
          error={errors.base_cost?.message}
        />

        <Input
          label="Preço base"
          type="number"
          step="0.01"
          {...register('base_price', { valueAsNumber: true })}
          error={errors.base_price?.message}
        />

        <div className="rounded-lg border p-3 text-sm">
          <span className="font-medium">Margem calculada: </span>
          <span>
            {basePrice > 0 ? `${margin.toFixed(1)}%` : '—'}
          </span>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" {...register('active')} />
          Produto ativo
        </label>

        <div className="flex gap-3 pt-2">
          <Link href={`/produtos/${params.id}`} className="flex-1">
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