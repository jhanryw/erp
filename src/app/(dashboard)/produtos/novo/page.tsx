'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, useFieldArray } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import Link from 'next/link'
import { ArrowLeft, Plus, Trash2, RefreshCw } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'

// ─── Tipos ────────────────────────────────────────────────────────────────────

type VariationValue = { id: number; value: string; slug: string }
type VariationType  = { id: number; name: string; slug: string; variation_values: VariationValue[] }

const variantRowSchema = z.object({
  sku_variation:   z.string().min(1, 'SKU obrigatório'),
  color_value_id:  z.number().nullable().optional(),
  size_value_id:   z.number().nullable().optional(),
  color_label:     z.string().optional(),
  size_label:      z.string().optional(),
  price_override:  z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().positive().nullable().optional()),
  cost_override:   z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().min(0).nullable().optional()),
  initial_stock:   z.coerce.number().int().min(0).default(0),
})

const formSchema = z.object({
  name:        z.string().min(2, 'Nome obrigatório'),
  sku:         z.string().min(2, 'SKU obrigatório').max(50),
  category_id: z.coerce.number({ invalid_type_error: 'Selecione uma categoria' }).int().positive('Selecione uma categoria'),
  supplier_id: z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().int().positive().nullable().optional()),
  origin:      z.enum(['own_brand', 'third_party']),
  base_cost:   z.coerce.number().min(0),
  base_price:  z.coerce.number().positive('Preço obrigatório'),
  active:      z.boolean().default(true),
  variants:    z.array(variantRowSchema),
})

type FormData = z.infer<typeof formSchema>

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugToLabel(slug: string) {
  return slug.toUpperCase().replace(/-/g, '')
}

function buildSku(baseSku: string, colorSlug?: string, sizeSlug?: string) {
  const parts = [baseSku.toUpperCase()]
  if (colorSlug) parts.push(slugToLabel(colorSlug))
  if (sizeSlug)  parts.push(slugToLabel(sizeSlug))
  return parts.join('-')
}

// ─── Componente ───────────────────────────────────────────────────────────────

export default function NovoProdutoPage() {
  const router = useRouter()

  const [categories,  setCategories]  = useState<{ id: number; name: string }[]>([])
  const [suppliers,   setSuppliers]   = useState<{ id: number; name: string }[]>([])
  const [varTypes,    setVarTypes]    = useState<VariationType[]>([])
  const [selColors,   setSelColors]   = useState<VariationValue[]>([])
  const [selSizes,    setSelSizes]    = useState<VariationValue[]>([])
  const [generated,   setGenerated]   = useState(false)

  const { register, handleSubmit, watch, control, setValue, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: { origin: 'third_party', base_cost: 0, active: true, variants: [] },
  })

  const { fields, replace } = useFieldArray({ control, name: 'variants' })

  const baseSku = watch('sku')

  // Carregar dados iniciais
  useEffect(() => {
    fetch('/api/categorias').then(r => r.json()).then(({ categories }) => setCategories(categories ?? []))
    fetch('/api/fornecedores').then(r => r.json()).then(({ suppliers }) => setSuppliers(suppliers ?? []))
    fetch('/api/variacoes').then(r => r.json()).then(({ types }) => setVarTypes(types ?? []))
  }, [])

  const colorType  = varTypes.find(t => t.slug === 'cor')
  const sizeType   = varTypes.find(t => t.slug === 'tamanho')
  const otherTypes = varTypes.filter(t => t.slug !== 'cor' && t.slug !== 'tamanho')

  // Gerar matriz de variantes
  const generateVariants = useCallback(() => {
    const hasColors = selColors.length > 0
    const hasSizes  = selSizes.length > 0

    if (!hasColors && !hasSizes) {
      toast.error('Selecione ao menos uma cor ou tamanho')
      return
    }

    const rows: FormData['variants'] = []

    if (hasColors && hasSizes) {
      selColors.forEach(color => {
        selSizes.forEach(size => {
          rows.push({
            sku_variation:  buildSku(baseSku || 'SKU', color.slug, size.slug),
            color_value_id: color.id,
            size_value_id:  size.id,
            color_label:    color.value,
            size_label:     size.value,
            price_override: null,
            cost_override:  null,
            initial_stock:  0,
          })
        })
      })
    } else if (hasColors) {
      selColors.forEach(color => {
        rows.push({
          sku_variation:  buildSku(baseSku || 'SKU', color.slug),
          color_value_id: color.id,
          size_value_id:  null,
          color_label:    color.value,
          size_label:     undefined,
          price_override: null,
          cost_override:  null,
          initial_stock:  0,
        })
      })
    } else {
      selSizes.forEach(size => {
        rows.push({
          sku_variation:  buildSku(baseSku || 'SKU', undefined, size.slug),
          color_value_id: null,
          size_value_id:  size.id,
          color_label:    undefined,
          size_label:     size.value,
          price_override: null,
          cost_override:  null,
          initial_stock:  0,
        })
      })
    }

    replace(rows)
    setGenerated(true)
    toast.success(`${rows.length} variante${rows.length > 1 ? 's' : ''} gerada${rows.length > 1 ? 's' : ''}`)
  }, [selColors, selSizes, baseSku, replace])

  function toggleColor(v: VariationValue) {
    setSelColors(prev => prev.find(c => c.id === v.id) ? prev.filter(c => c.id !== v.id) : [...prev, v])
    setGenerated(false)
  }

  function toggleSize(v: VariationValue) {
    setSelSizes(prev => prev.find(s => s.id === v.id) ? prev.filter(s => s.id !== v.id) : [...prev, v])
    setGenerated(false)
  }

  // Submit
  async function onSubmit(data: FormData) {
    if (data.variants.length === 0) {
      toast.error('Gere ao menos uma variante antes de salvar')
      return
    }

    const res = await fetch('/api/produtos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        category_id: Number(data.category_id),
        supplier_id: data.supplier_id ? Number(data.supplier_id) : null,
        base_cost:   Number(data.base_cost),
        base_price:  Number(data.base_price),
      }),
    })

    const json = await res.json()
    if (!res.ok) {
      toast.error('Erro ao cadastrar produto', { description: json.error })
      return
    }

    toast.success('Produto cadastrado com sucesso!')
    router.refresh()
    router.push(`/produtos/${json.product.id}`)
  }

  const baseCost  = Number(watch('base_cost')) || 0
  const basePrice = Number(watch('base_price')) || 0
  const margin    = basePrice > 0 ? ((basePrice - baseCost) / basePrice) * 100 : 0

  return (
    <div className="max-w-5xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/produtos">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Novo Produto</h2>
          <p className="text-sm text-text-muted">Preencha os dados e gere a grade de variantes</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">

        {/* ── Seção 1: Dados do Produto ── */}
        <div className="card p-6 space-y-5">
          <h3 className="text-sm font-semibold text-text-primary border-b border-border pb-3">Informações do Produto</h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Nome do produto" required placeholder="Ex: Body de Renda Floral" error={errors.name?.message} {...register('name')} />
            <Input label="SKU base" required placeholder="Ex: BODY-RD-001" hint="Usado como prefixo nos SKUs das variantes" error={errors.sku?.message} {...register('sku')} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select label="Categoria" required error={errors.category_id?.message} {...register('category_id')}>
              <option value="">Selecione a categoria</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Select label="Fornecedor" {...register('supplier_id')}>
              <option value="">Sem fornecedor</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>

          <Select label="Origem do produto" required {...register('origin')}>
            <option value="third_party">Terceiro (comprado de fornecedor)</option>
            <option value="own_brand">Marca Própria (produção interna)</option>
          </Select>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Input label="Custo base (R$)" type="number" step="0.01" min="0" placeholder="0,00" error={errors.base_cost?.message} {...register('base_cost')} />
            <Input label="Preço de venda base (R$)" required type="number" step="0.01" min="0.01" placeholder="0,00" error={errors.base_price?.message} {...register('base_price')} />
            <div>
              <label className="label-base">Margem calculada</label>
              <div className={`input-base pointer-events-none font-semibold ${margin >= 40 ? 'text-success' : margin >= 25 ? 'text-warning' : margin > 0 ? 'text-error' : 'text-text-muted'}`}>
                {basePrice > 0 ? `${margin.toFixed(1)}%` : '—'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <input type="checkbox" id="active" defaultChecked className="w-4 h-4 rounded border-border bg-bg-input accent-brand" {...register('active')} />
            <label htmlFor="active" className="text-sm text-text-primary cursor-pointer">Produto ativo (visível nas vendas)</label>
          </div>
        </div>

        {/* ── Seção 2: Seleção de Atributos ── */}
        <div className="card p-6 space-y-5">
          <h3 className="text-sm font-semibold text-text-primary border-b border-border pb-3">Grade de Variantes</h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {/* Cores */}
            {colorType && (
              <div>
                <label className="label-base mb-2 block">Cores <span className="text-text-muted font-normal">(selecione as disponíveis)</span></label>
                <div className="flex flex-wrap gap-2">
                  {colorType.variation_values.map(v => {
                    const active = selColors.some(c => c.id === v.id)
                    return (
                      <button key={v.id} type="button" onClick={() => toggleColor(v)}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${active ? 'bg-brand text-white border-brand' : 'bg-bg-overlay text-text-secondary border-border hover:border-brand'}`}>
                        {v.value}
                      </button>
                    )
                  })}
                </div>
                {selColors.length > 0 && <p className="text-xs text-text-muted mt-2">{selColors.length} cor{selColors.length > 1 ? 'es' : ''} selecionada{selColors.length > 1 ? 's' : ''}</p>}
              </div>
            )}

            {/* Tamanhos */}
            {sizeType && (
              <div>
                <label className="label-base mb-2 block">Tamanhos <span className="text-text-muted font-normal">(selecione os disponíveis)</span></label>
                <div className="flex flex-wrap gap-2">
                  {sizeType.variation_values.map(v => {
                    const active = selSizes.some(s => s.id === v.id)
                    return (
                      <button key={v.id} type="button" onClick={() => toggleSize(v)}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${active ? 'bg-brand text-white border-brand' : 'bg-bg-overlay text-text-secondary border-border hover:border-brand'}`}>
                        {v.value}
                      </button>
                    )
                  })}
                </div>
                {selSizes.length > 0 && <p className="text-xs text-text-muted mt-2">{selSizes.length} tamanho{selSizes.length > 1 ? 's' : ''} selecionado{selSizes.length > 1 ? 's' : ''}</p>}
              </div>
            )}

            {/* Outros tipos de variação */}
            {otherTypes.map(type => (
              <div key={type.id}>
                <label className="label-base mb-2 block">{type.name}</label>
                <div className="flex flex-wrap gap-2">
                  {type.variation_values.map(v => (
                    <span key={v.id} className="px-3 py-1.5 rounded-full text-xs font-medium border border-border bg-bg-overlay text-text-muted">{v.value}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Botão gerar */}
          <div className="flex items-center gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={generateVariants}
              disabled={selColors.length === 0 && selSizes.length === 0}>
              <RefreshCw className="w-4 h-4" />
              {generated ? 'Regerar Matriz' : 'Gerar Matriz de Variantes'}
            </Button>
            {generated && (
              <span className="text-sm text-text-muted">{fields.length} variante{fields.length > 1 ? 's' : ''} • clique em "Regerar" para atualizar após mudar seleção</span>
            )}
          </div>
        </div>

        {/* ── Seção 3: Tabela de Variantes ── */}
        {fields.length > 0 && (
          <div className="card overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">
                Matriz de SKUs <span className="text-text-muted font-normal">({fields.length} variantes)</span>
              </h3>
              <p className="text-xs text-text-muted">Preço/custo em branco = usa o valor base do produto</p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-bg-overlay border-b border-border">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-muted">Variante</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-muted w-48">SKU</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-muted w-32">Custo (R$)</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-muted w-32">Preço (R$)</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-muted w-28">Estoque Inicial</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {fields.map((field, idx) => (
                    <tr key={field.id} className="hover:bg-bg-overlay/50 transition-colors">
                      {/* Label da variante */}
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap gap-1">
                          {field.color_label && (
                            <span className="px-2 py-0.5 rounded-full bg-brand/10 text-brand text-xs font-medium">{field.color_label}</span>
                          )}
                          {field.size_label && (
                            <span className="px-2 py-0.5 rounded-full bg-bg-overlay border border-border text-text-secondary text-xs font-medium">{field.size_label}</span>
                          )}
                        </div>
                      </td>

                      {/* SKU */}
                      <td className="px-4 py-2">
                        <input
                          className="input-base text-xs font-mono py-1.5 w-full"
                          {...register(`variants.${idx}.sku_variation`)}
                        />
                        {errors.variants?.[idx]?.sku_variation && (
                          <p className="text-xs text-error mt-0.5">{errors.variants[idx]?.sku_variation?.message}</p>
                        )}
                      </td>

                      {/* Custo override */}
                      <td className="px-4 py-2">
                        <input
                          type="number" step="0.01" min="0"
                          placeholder={`${baseCost.toFixed(2)}`}
                          className="input-base text-xs py-1.5 w-full"
                          {...register(`variants.${idx}.cost_override`)}
                        />
                      </td>

                      {/* Preço override */}
                      <td className="px-4 py-2">
                        <input
                          type="number" step="0.01" min="0"
                          placeholder={`${basePrice.toFixed(2)}`}
                          className="input-base text-xs py-1.5 w-full"
                          {...register(`variants.${idx}.price_override`)}
                        />
                      </td>

                      {/* Estoque inicial */}
                      <td className="px-4 py-2">
                        <input
                          type="number" min="0"
                          className="input-base text-xs py-1.5 w-full"
                          {...register(`variants.${idx}.initial_stock`)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Linha de totais */}
            <div className="px-5 py-3 border-t border-border bg-bg-overlay flex items-center gap-6 text-xs text-text-muted">
              <span><strong className="text-text-primary">{fields.length}</strong> variantes</span>
              <span><strong className="text-text-primary">{selColors.length}</strong> cores × <strong className="text-text-primary">{selSizes.length || 1}</strong> tamanhos</span>
            </div>
          </div>
        )}

        {/* ── Ações ── */}
        <div className="flex gap-3">
          <Link href="/produtos" className="flex-1">
            <Button type="button" variant="secondary" className="w-full">Cancelar</Button>
          </Link>
          <Button type="submit" loading={isSubmitting} className="flex-1" disabled={fields.length === 0}>
            <Plus className="w-4 h-4" />
            Salvar Produto ({fields.length} variante{fields.length !== 1 ? 's' : ''})
          </Button>
        </div>

      </form>
    </div>
  )
}
