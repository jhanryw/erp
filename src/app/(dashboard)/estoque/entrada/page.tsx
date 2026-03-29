'use client'

import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Calculator, Package } from 'lucide-react'
import { stockLotSchema, type StockLotFormData } from '@/lib/validators'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { formatCurrency } from '@/lib/utils/currency'

export default function EstoqueEntradaPage() {
  const router = useRouter()
  const supabase = createClient()
  const [loading, setLoading] = useState(false)
  const [products, setProducts] = useState<{ id: number; name: string; sku: string }[]>([])
  const [variations, setVariations] = useState<{ id: number; sku_variation: string; product_variation_attributes: { variation_values: { value: string } | null }[] }[]>([])
  const [suppliers, setSuppliers] = useState<{ id: number; name: string }[]>([])
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null)

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<StockLotFormData>({
    resolver: zodResolver(stockLotSchema),
    defaultValues: {
      entry_type: 'purchase',
      unit_cost: 0,
      freight_cost: 0,
      tax_cost: 0,
      entry_date: new Date().toISOString().slice(0, 10),
    },
  })

  const qty = watch('quantity_original') ?? 0
  const unitCost = watch('unit_cost') ?? 0
  const freightCost = watch('freight_cost') ?? 0
  const taxCost = watch('tax_cost') ?? 0
  const totalLotCost = unitCost * qty + freightCost + taxCost
  const costPerUnit = qty > 0 ? totalLotCost / qty : 0

  useEffect(() => {
    Promise.all([
      supabase.from('products').select('id, name, sku').eq('active', true).order('name'),
      supabase.from('suppliers').select('id, name').eq('active', true).order('name'),
    ]).then(([prods, supps]) => {
      setProducts(prods.data ?? [])
      setSuppliers(supps.data ?? [])
    })
  }, [])

  useEffect(() => {
    if (!selectedProductId) {
      setVariations([])
      return
    }
    supabase
      .from('product_variations')
      .select('id, sku_variation, product_variation_attributes(variation_values:variation_value_id(value))')
      .eq('product_id', selectedProductId)
      .eq('active', true)
      .then(({ data }) => setVariations((data as any) ?? []))
  }, [selectedProductId])

  const onSubmit = async (values: StockLotFormData) => {
    setLoading(true)
    try {
      const res = await fetch('/api/estoque/entrada', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error ?? 'Erro ao registrar entrada')
      }
      toast.success('Entrada de estoque registrada!')
      router.push('/estoque')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro desconhecido')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-5 max-w-2xl">
      <div className="flex items-center gap-3">
        <Link href="/estoque">
          <button className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Registrar Entrada</h2>
          <p className="text-sm text-text-muted">Entrada de lote no estoque</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {/* Produto e Variação */}
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <Package className="w-4 h-4" />
              Produto e Variação
            </h3>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="label-base">Produto *</label>
              <select
                className="input-base"
                onChange={(e) =>
                  setSelectedProductId(e.target.value ? Number(e.target.value) : null)
                }
              >
                <option value="">Selecione um produto...</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.sku}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label-base">Variação (cor / tamanho / modelo) *</label>
              <select
                className="input-base"
                {...register('product_variation_id', { valueAsNumber: true })}
                disabled={!selectedProductId}
              >
                <option value="">Selecione a variação...</option>
                {variations.map((v) => {
                  const attrs = (v.product_variation_attributes ?? [])
                    .map((a) => a.variation_values?.value)
                    .filter(Boolean)
                    .join(' / ')
                  return (
                    <option key={v.id} value={v.id}>
                      {v.sku_variation}{attrs ? ` — ${attrs}` : ''}
                    </option>
                  )
                })}
              </select>
              {errors.product_variation_id && (
                <p className="text-xs text-error mt-1">{errors.product_variation_id.message}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label-base">Tipo de Entrada *</label>
                <select className="input-base" {...register('entry_type')}>
                  <option value="purchase">Compra de Fornecedor</option>
                  <option value="own_production">Produção Própria</option>
                </select>
              </div>
              <div>
                <label className="label-base">Fornecedor</label>
                <select
                  className="input-base"
                  {...register('supplier_id', { setValueAs: (v) => (v ? Number(v) : null) })}
                >
                  <option value="">Sem fornecedor</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Quantidades e Custos */}
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <Calculator className="w-4 h-4" />
              Quantidades e Custos
            </h3>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Quantidade *"
                type="number"
                min="1"
                {...register('quantity_original', { valueAsNumber: true })}
                error={errors.quantity_original?.message}
              />
              <Input
                label="Custo Unitário (R$) *"
                type="number"
                step="0.01"
                min="0"
                {...register('unit_cost', { valueAsNumber: true })}
                error={errors.unit_cost?.message}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Frete (R$)"
                type="number"
                step="0.01"
                min="0"
                {...register('freight_cost', { valueAsNumber: true })}
              />
              <Input
                label="Impostos (R$)"
                type="number"
                step="0.01"
                min="0"
                {...register('tax_cost', { valueAsNumber: true })}
              />
            </div>

            {/* Preview de custo do lote */}
            {qty > 0 && (
              <div className="p-3 rounded-lg bg-bg-overlay border border-border space-y-1.5">
                <div className="flex justify-between text-xs text-text-muted">
                  <span>Mercadoria ({qty} un × {formatCurrency(unitCost)})</span>
                  <span>{formatCurrency(unitCost * qty)}</span>
                </div>
                <div className="flex justify-between text-xs text-text-muted">
                  <span>Frete</span>
                  <span>{formatCurrency(freightCost)}</span>
                </div>
                <div className="flex justify-between text-xs text-text-muted">
                  <span>Impostos</span>
                  <span>{formatCurrency(taxCost)}</span>
                </div>
                <div className="flex justify-between text-sm font-semibold text-text-primary border-t border-border pt-1.5">
                  <span>Custo total do lote</span>
                  <span>{formatCurrency(totalLotCost)}</span>
                </div>
                <div className="flex justify-between text-xs text-success font-medium">
                  <span>Custo por unidade</span>
                  <span>{formatCurrency(costPerUnit)}</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Data e Observações */}
        <Card>
          <CardContent className="space-y-4 pt-4">
            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Data de Entrada *"
                type="date"
                {...register('entry_date')}
                error={errors.entry_date?.message}
              />
            </div>
            <div>
              <label className="label-base">Observações</label>
              <textarea
                className="input-base resize-none"
                rows={3}
                placeholder="Notas opcionais sobre este lote..."
                {...register('notes')}
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-3">
          <Button type="submit" disabled={loading}>
            {loading ? 'Registrando...' : 'Registrar Entrada'}
          </Button>
          <Link href="/estoque">
            <Button variant="secondary" type="button">
              Cancelar
            </Button>
          </Link>
        </div>
      </form>
    </div>
  )
}
