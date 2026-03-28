'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import Link from 'next/link'
import { ArrowLeft, Trash2, Plus } from 'lucide-react'
import { productSchema, type ProductFormData } from '@/lib/validators'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'

// ── Types ──────────────────────────────────────────────────────────────────────

type AttributeRow = {
  variation_type_id: number
  variation_value_id: number
  variation_types: { name: string; slug: string } | null
  variation_values: { value: string; slug: string } | null
}

type VariationRow = {
  id: number
  sku_variation: string
  cost_override: number | null
  price_override: number | null
  active: boolean
  product_variation_attributes: AttributeRow[]
}

type VariationValue = { id: number; value: string; slug: string }

type VariationType = {
  id: number
  name: string
  slug: string
  variation_values: VariationValue[]
}

type NewVariation = {
  key: string // client-only unique key
  sku_variation: string
  color_value_id: number | null
  size_value_id: number | null
  price_override: number | null
  cost_override: number | null
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function attrLabel(v: VariationRow): string {
  return v.product_variation_attributes
    .map((a) => a.variation_values?.value)
    .filter(Boolean)
    .join(' / ') || '—'
}

function fmtCurrency(n: number | null) {
  if (n == null) return 'base'
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function EditarProdutoPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [categories, setCategories] = useState<any[]>([])
  const [suppliers, setSuppliers] = useState<any[]>([])

  // Variation state
  const [variations, setVariations] = useState<VariationRow[]>([])
  const [toDelete, setToDelete] = useState<number[]>([])
  const [toAdd, setToAdd] = useState<NewVariation[]>([])
  const [variationTypes, setVariationTypes] = useState<VariationType[]>([])

  // New variation form fields
  const [newSku, setNewSku] = useState('')
  const [newColorId, setNewColorId] = useState<number | ''>('')
  const [newSizeId, setNewSizeId] = useState<number | ''>('')
  const [newPrice, setNewPrice] = useState('')
  const [newCost, setNewCost] = useState('')

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ProductFormData>({
    resolver: zodResolver(productSchema),
  })

  const baseCost = Number(watch('base_cost')) || 0
  const basePrice = Number(watch('base_price')) || 0
  const margin = basePrice > 0 ? ((basePrice - baseCost) / basePrice) * 100 : 0

  useEffect(() => {
    Promise.all([
      fetch('/api/categorias').then(r => r.json()),
      fetch('/api/fornecedores').then(r => r.json()),
      fetch(`/api/produtos/${params.id}`).then(r => r.json()),
      fetch('/api/variacoes').then(r => r.json()),
    ]).then(([catsJson, supsJson, prodJson, varJson]) => {
      setCategories(catsJson.categories ?? [])
      setSuppliers(supsJson.suppliers ?? [])
      setVariationTypes(varJson.types ?? [])

      const { product, error } = prodJson
      if (error || !product) {
        toast.error('Produto não encontrado')
        router.push('/produtos')
        return
      }

      setVariations(prodJson.variations ?? [])

      reset({
        name: product.name ?? '',
        sku: product.sku ?? '',
        category_id: product.category_id,
        supplier_id: product.supplier_id ?? undefined,
        origin: product.origin ?? 'third_party',
        base_cost: product.base_cost ?? 0,
        base_price: product.base_price ?? 0,
        active: product.active ?? true,
      })
      setLoading(false)
    })
  }, [params.id, reset, router])

  // ── Variation handlers ───────────────────────────────────────────────────────

  function markForDelete(id: number) {
    setToDelete(prev => [...prev, id])
    setVariations(prev => prev.filter(v => v.id !== id))
  }

  function addVariation() {
    if (!newSku.trim()) {
      toast.error('Informe o SKU da variação')
      return
    }

    const duplicate =
      variations.some(v => v.sku_variation === newSku.trim()) ||
      toAdd.some(v => v.sku_variation === newSku.trim())

    if (duplicate) {
      toast.error('SKU de variação já existe neste produto')
      return
    }

    setToAdd(prev => [
      ...prev,
      {
        key: `new-${Date.now()}`,
        sku_variation: newSku.trim(),
        color_value_id: newColorId !== '' ? Number(newColorId) : null,
        size_value_id: newSizeId !== '' ? Number(newSizeId) : null,
        price_override: newPrice !== '' ? Number(newPrice) : null,
        cost_override: newCost !== '' ? Number(newCost) : null,
      },
    ])

    setNewSku('')
    setNewColorId('')
    setNewSizeId('')
    setNewPrice('')
    setNewCost('')
  }

  function removeToAdd(key: string) {
    setToAdd(prev => prev.filter(v => v.key !== key))
  }

  // ── Submit ───────────────────────────────────────────────────────────────────

  async function onSubmit(data: ProductFormData) {
    const payload = {
      ...data,
      category_id: Number(data.category_id),
      supplier_id: data.supplier_id ? Number(data.supplier_id) : null,
      base_cost: Number(data.base_cost),
      base_price: Number(data.base_price),
      variations_to_delete: toDelete,
      variations_to_add: toAdd.map(({ key: _key, ...v }) => v),
    }

    const res = await fetch(`/api/produtos/${params.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const json = await res.json()

    if (!res.ok) {
      toast.error('Erro ao atualizar produto', { description: json.error })
      return
    }

    toast.success('Produto atualizado!')
    router.push(`/produtos/${params.id}`)
    router.refresh()
  }

  // ── Derived data ─────────────────────────────────────────────────────────────

  const colorType = variationTypes.find(t => t.slug === 'cor')
  const sizeType = variationTypes.find(t => t.slug === 'tamanho')

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-text-muted">Carregando produto...</p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href={`/produtos/${params.id}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Editar Produto</h2>
          <p className="text-sm text-text-muted">Altere as informações do produto</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        {/* ── Dados base ── */}
        <div className="card p-6 space-y-5">
          <h3 className="text-sm font-semibold text-text-primary">Dados do produto</h3>

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
              className="w-4 h-4 rounded border-border bg-bg-input accent-brand"
              {...register('active')}
            />
            <label htmlFor="active" className="text-sm text-text-primary cursor-pointer">
              Produto ativo (visível nas vendas)
            </label>
          </div>
        </div>

        {/* ── Variações existentes ── */}
        <div className="card p-6 space-y-4">
          <h3 className="text-sm font-semibold text-text-primary">
            Variações existentes ({variations.length})
          </h3>

          {variations.length === 0 ? (
            <p className="text-sm text-text-muted">Nenhuma variação cadastrada.</p>
          ) : (
            <div className="divide-y divide-border">
              {variations.map((v) => (
                <div key={v.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <code className="text-xs text-text-primary">{v.sku_variation}</code>
                    <p className="text-xs text-text-muted">{attrLabel(v)}</p>
                    <p className="text-xs text-text-muted">
                      Custo: {fmtCurrency(v.cost_override)} · Preço: {fmtCurrency(v.price_override)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => markForDelete(v.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {toDelete.length > 0 && (
            <p className="text-xs text-warning">
              {toDelete.length} variação(ões) marcada(s) para exclusão ao salvar.
            </p>
          )}
        </div>

        {/* ── Adicionar variação ── */}
        <div className="card p-6 space-y-4">
          <h3 className="text-sm font-semibold text-text-primary">Adicionar variação</h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="SKU da variação"
              required
              placeholder="Ex: BODY-RD-001-P-PRETO"
              value={newSku}
              onChange={e => setNewSku(e.target.value)}
            />

            {colorType && (
              <div>
                <label className="label-base">Cor</label>
                <select
                  className="input-base"
                  value={newColorId}
                  onChange={e => setNewColorId(e.target.value !== '' ? Number(e.target.value) : '')}
                >
                  <option value="">Sem cor</option>
                  {colorType.variation_values.map(vv => (
                    <option key={vv.id} value={vv.id}>{vv.value}</option>
                  ))}
                </select>
              </div>
            )}

            {sizeType && (
              <div>
                <label className="label-base">Tamanho</label>
                <select
                  className="input-base"
                  value={newSizeId}
                  onChange={e => setNewSizeId(e.target.value !== '' ? Number(e.target.value) : '')}
                >
                  <option value="">Sem tamanho</option>
                  {sizeType.variation_values.map(vv => (
                    <option key={vv.id} value={vv.id}>{vv.value}</option>
                  ))}
                </select>
              </div>
            )}

            <Input
              label="Custo override (R$)"
              type="number"
              step="0.01"
              min="0"
              placeholder="Deixe vazio para usar o base"
              value={newCost}
              onChange={e => setNewCost(e.target.value)}
            />

            <Input
              label="Preço override (R$)"
              type="number"
              step="0.01"
              min="0.01"
              placeholder="Deixe vazio para usar o base"
              value={newPrice}
              onChange={e => setNewPrice(e.target.value)}
            />
          </div>

          <Button type="button" variant="outline" size="sm" onClick={addVariation}>
            <Plus className="h-4 w-4 mr-1" />
            Adicionar variação
          </Button>

          {/* Fila de novas variações */}
          {toAdd.length > 0 && (
            <div className="divide-y divide-border mt-2">
              {toAdd.map((v) => (
                <div key={v.key} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <code className="text-xs text-text-primary">{v.sku_variation}</code>
                    <p className="text-xs text-text-muted">
                      Custo: {v.cost_override != null ? `R$ ${v.cost_override}` : 'base'} · Preço:{' '}
                      {v.price_override != null ? `R$ ${v.price_override}` : 'base'}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeToAdd(v.key)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-error" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Ações ── */}
        <div className="flex gap-3">
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
