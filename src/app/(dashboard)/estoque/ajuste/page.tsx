'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ProductSearchCombobox, type ProductOption } from '@/components/ui/product-search-combobox'

const REASONS = [
  { value: 'loss',               label: 'Perda / Avaria' },
  { value: 'inventory',          label: 'Ajuste de Inventário' },
  { value: 'return_to_supplier', label: 'Devolução ao Fornecedor' },
  { value: 'sample',             label: 'Amostra / Brinde' },
  { value: 'other',              label: 'Outro' },
]

const schema = z.object({
  product_variation_id: z.coerce.number().min(1, 'Selecione uma variação'),
  delta:  z.coerce.number().int('Deve ser número inteiro').refine((n) => n !== 0, 'Não pode ser zero'),
  reason: z.string().min(1, 'Selecione o motivo'),
  notes:  z.string().optional(),
})

type FormData = z.infer<typeof schema>

type Product   = { id: number; name: string; sku: string }
type Variation = { id: number; sku_variation: string; attrs: string }

const SELECT_CLASS =
  'w-full bg-bg-input border border-border text-text-primary text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-brand'

export default function EstoqueAjustePage() {
  const router  = useRouter()
  const supabase = createClient()

  const [allProducts, setAllProducts]         = useState<ProductOption[]>([])
  const [selectedProduct, setSelectedProduct] = useState<ProductOption | null>(null)
  const [variations, setVariations]   = useState<Variation[]>([])
  const [loadingVars, setLoadingVars] = useState(false)

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) })

  useEffect(() => {
    supabase
      .from('products')
      .select('id, name, sku')
      .order('name')
      .then(({ data }) => setAllProducts(data ?? []))
  }, [])

  // Buscar variações ao selecionar produto
  useEffect(() => {
    if (!selectedProduct) {
      setVariations([])
      setValue('product_variation_id', 0)
      return
    }
    setLoadingVars(true)
    setValue('product_variation_id', 0)
    supabase
      .from('product_variations')
      .select('id, sku_variation, product_variation_attributes(variation_values:variation_value_id(value))')
      .eq('product_id', selectedProduct.id)
      .then(({ data }) => {
        const rows = (data as any[]) ?? []
        setVariations(rows.map((v) => ({
          id:            v.id,
          sku_variation: v.sku_variation,
          attrs: (v.product_variation_attributes ?? [])
            .map((a: any) => a.variation_values?.value)
            .filter(Boolean)
            .join(' / '),
        })))
        setLoadingVars(false)
      })
  }, [selectedProduct])

  const KNOWN_ERRORS: Record<string, string> = {
    'variação não encontrada': 'Variação de produto não encontrada.',
    'estoque insuficiente':    'Estoque insuficiente para realizar a saída.',
    'stock not found':         'Registro de estoque não encontrado para essa variação.',
    'delta cannot be zero':    'A quantidade não pode ser zero.',
  }

  function parseErrorMessage(err: unknown): string {
    if (typeof err === 'string') {
      const lower = err.toLowerCase()
      for (const [key, friendly] of Object.entries(KNOWN_ERRORS)) {
        if (lower.includes(key)) return friendly
      }
      return err
    }
    if (err && typeof err === 'object') {
      const obj = err as Record<string, unknown>
      if (typeof obj.error === 'string') return parseErrorMessage(obj.error)
      const fieldErrors = obj.fieldErrors as Record<string, string[]> | undefined
      if (fieldErrors) {
        const first = Object.values(fieldErrors)[0]?.[0]
        if (first) return first
      }
    }
    return 'Verifique os dados e tente novamente.'
  }

  async function onSubmit(data: FormData) {
    const res = await fetch('/api/estoque/ajuste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_variation_id: data.product_variation_id,
        delta:  data.delta,
        reason: data.reason,
        notes:  data.notes?.trim() || null,
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.error('Erro ao registrar ajuste', { description: parseErrorMessage(err.error ?? err) })
      return
    }

    toast.success('Ajuste registrado com sucesso')
    router.push('/estoque')
  }

  return (
    <div className="max-w-xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/estoque">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <h2 className="text-lg font-semibold text-text-primary">Ajuste Manual de Estoque</h2>
      </div>

      <Card>
        <CardContent className="pt-5">
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">

            {/* ── Busca de produto ─────────────────────────── */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-text-primary">Produto</label>
              <ProductSearchCombobox
                products={allProducts}
                value={selectedProduct}
                onChange={setSelectedProduct}
              />
            </div>

            {/* ── Variação ────────────────────────────────── */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-text-primary">Variação</label>
              <select
                className={SELECT_CLASS}
                disabled={!selectedProduct || loadingVars}
                {...register('product_variation_id')}
              >
                <option value="0">
                  {!selectedProduct
                    ? 'Selecione um produto primeiro'
                    : loadingVars
                      ? 'Carregando...'
                      : 'Selecione a variação'}
                </option>
                {variations.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.sku_variation}{v.attrs ? ` — ${v.attrs}` : ''}
                  </option>
                ))}
              </select>
              {errors.product_variation_id && (
                <p className="text-xs text-error">{errors.product_variation_id.message}</p>
              )}
            </div>

            {/* ── Motivo ──────────────────────────────────── */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-text-primary">Motivo</label>
              <select className={SELECT_CLASS} {...register('reason')}>
                <option value="">Selecione o motivo</option>
                {REASONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              {errors.reason && (
                <p className="text-xs text-error">{errors.reason.message}</p>
              )}
            </div>

            {/* ── Quantidade ──────────────────────────────── */}
            <Input
              label="Quantidade"
              type="number"
              placeholder="Ex: -5 para perda, +10 para entrada"
              error={errors.delta?.message}
              {...register('delta')}
            />
            <p className="text-xs text-text-muted -mt-2">
              Use valor negativo para redução (perda/saída) e positivo para adição.
            </p>

            {/* ── Observações ─────────────────────────────── */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-text-primary">
                Observações <span className="text-text-muted font-normal">(opcional)</span>
              </label>
              <textarea
                className={`${SELECT_CLASS} resize-none`}
                rows={3}
                placeholder="Detalhe o motivo do ajuste..."
                {...register('notes')}
              />
            </div>

            <Button type="submit" className="w-full" loading={isSubmitting}>
              Registrar Ajuste
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
