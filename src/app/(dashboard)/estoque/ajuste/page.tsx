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

const REASONS = [
  { value: 'loss', label: 'Perda / Avaria' },
  { value: 'inventory', label: 'Ajuste de Inventário' },
  { value: 'return_to_supplier', label: 'Devolução ao Fornecedor' },
  { value: 'sample', label: 'Amostra / Brinde' },
  { value: 'other', label: 'Outro' },
]

const schema = z.object({
  product_variation_id: z.coerce
    .number()
    .min(1, 'Selecione uma variação'),
  delta: z.coerce
    .number()
    .int('Deve ser número inteiro')
    .refine((n) => n !== 0, 'Não pode ser zero'),
  reason: z.string().min(1, 'Selecione o motivo'),
  notes: z.string().optional(),
})

type FormData = z.infer<typeof schema>

const SELECT_CLASS =
  'w-full bg-bg-input border border-border text-text-primary text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-brand'

export default function EstoqueAjustePage() {
  const router = useRouter()
  const supabase = createClient()

  const [products, setProducts] = useState<any[]>([])
  const [variations, setVariations] = useState<any[]>([])
  const [selectedProduct, setSelectedProduct] = useState<number | null>(null)

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
      .eq('active', true)
      .order('name')
      .then(({ data }) => setProducts(data ?? []))
  }, [])

  useEffect(() => {
    if (!selectedProduct) {
      setVariations([])
      return
    }
    supabase
      .from('product_variations')
      .select('id, sku_variation, color, size, model, fabric')
      .eq('product_id', selectedProduct)
      .eq('active', true)
      .then(({ data }) => setVariations(data ?? []))
  }, [selectedProduct])

  async function onSubmit(data: FormData) {
    const res = await fetch('/api/estoque/ajuste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      const err = await res.json()
      toast.error('Erro ao registrar ajuste', { description: err.error })
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
            {/* Product */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-text-primary">Produto</label>
              <select
                className={SELECT_CLASS}
                onChange={(e) => {
                  setSelectedProduct(Number(e.target.value) || null)
                  setValue('product_variation_id', 0)
                }}
              >
                <option value="">Selecione um produto</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku})
                  </option>
                ))}
              </select>
            </div>

            {/* Variation */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-text-primary">Variação</label>
              <select
                className={SELECT_CLASS}
                disabled={!selectedProduct}
                {...register('product_variation_id')}
              >
                <option value="0">Selecione uma variação</option>
                {variations.map((v) => {
                  const dims = [v.color, v.size, v.model, v.fabric].filter(Boolean).join(' / ')
                  return (
                    <option key={v.id} value={v.id}>
                      {v.sku_variation}{dims ? ` — ${dims}` : ''}
                    </option>
                  )
                })}
              </select>
              {errors.product_variation_id && (
                <p className="text-xs text-error">{errors.product_variation_id.message}</p>
              )}
            </div>

            {/* Reason */}
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

            {/* Delta */}
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

            {/* Notes */}
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
