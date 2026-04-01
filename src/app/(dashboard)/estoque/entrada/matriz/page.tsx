'use client'

import { useState, useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Grid3X3, Calculator, Package } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { formatCurrency } from '@/lib/utils/currency'

// ─── Tipos ────────────────────────────────────────────────────────────────────

type AttrValue = { id: number; value: string }

type VariationAttr = {
  variation_type_id: number
  variation_value_id: number
  variation_types: { name: string; slug: string }
  variation_values: { value: string; slug: string }
}

type Variation = {
  id: number
  sku_variation: string
  product_variation_attributes: VariationAttr[]
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EstoqueEntradaMatrizPage() {
  const router = useRouter()
  const supabase = createClient()

  // ── Dados base ──────────────────────────────────────────────────────────────
  const [products, setProducts] = useState<{ id: number; name: string; sku: string }[]>([])
  const [suppliers, setSuppliers] = useState<{ id: number; name: string }[]>([])
  const [variations, setVariations] = useState<Variation[]>([])
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null)
  const [loadingVariations, setLoadingVariations] = useState(false)

  // ── Campos comuns ───────────────────────────────────────────────────────────
  const [entryType, setEntryType] = useState<'purchase' | 'own_production'>('purchase')
  const [supplierId, setSupplierId] = useState<number | null>(null)
  const [unitCost, setUnitCost] = useState<number>(0)
  const [freightTotal, setFreightTotal] = useState<number>(0)
  const [taxTotal, setTaxTotal] = useState<number>(0)
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10))
  const [notes, setNotes] = useState('')

  // ── Grade de quantidades: variationId → qty ─────────────────────────────────
  const [quantities, setQuantities] = useState<Record<number, number>>({})

  const [submitting, setSubmitting] = useState(false)

  // ── Carga inicial ────────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      supabase.from('products').select('id, name, sku').eq('active', true).order('name'),
      supabase.from('suppliers').select('id, name').eq('active', true).order('name'),
    ]).then(([prods, supps]) => {
      setProducts(prods.data ?? [])
      setSuppliers(supps.data ?? [])
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Variações por produto ────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedProductId) {
      setVariations([])
      setQuantities({})
      return
    }

    setLoadingVariations(true)
    supabase
      .from('product_variations')
      .select(`
        id, sku_variation,
        product_variation_attributes (
          variation_type_id, variation_value_id,
          variation_types:variation_type_id ( name, slug ),
          variation_values:variation_value_id ( value, slug )
        )
      `)
      .eq('product_id', selectedProductId)
      .eq('active', true)
      .then(({ data }) => {
        setVariations((data as unknown as Variation[]) ?? [])
        setQuantities({})
        setLoadingVariations(false)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProductId])

  // ── Construção da grade ──────────────────────────────────────────────────────
  const { colors, sizes, variationLookup, hasBoth, hasColors, hasSizes } = useMemo(() => {
    const colorMap = new Map<number, string>()
    const sizeMap = new Map<number, string>()
    // chave: `${colorValueId}-${sizeValueId}`, valor 0 quando a dimensão não existe
    const lookup = new Map<string, number>()

    for (const v of variations) {
      let colorId = 0
      let sizeId = 0

      for (const attr of v.product_variation_attributes) {
        if (attr.variation_types?.slug === 'cor') {
          colorId = attr.variation_value_id
          colorMap.set(attr.variation_value_id, attr.variation_values.value)
        } else if (attr.variation_types?.slug === 'tamanho') {
          sizeId = attr.variation_value_id
          sizeMap.set(attr.variation_value_id, attr.variation_values.value)
        }
      }

      lookup.set(`${colorId}-${sizeId}`, v.id)
    }

    const colors: AttrValue[] = Array.from(colorMap.entries()).map(([id, value]) => ({ id, value }))
    const sizes: AttrValue[] = Array.from(sizeMap.entries()).map(([id, value]) => ({ id, value }))

    return {
      colors,
      sizes,
      variationLookup: lookup,
      hasBoth: colors.length > 0 && sizes.length > 0,
      hasColors: colors.length > 0,
      hasSizes: sizes.length > 0,
    }
  }, [variations])

  // ── Totais derivados ─────────────────────────────────────────────────────────
  const totalQty = Object.values(quantities).reduce((s, q) => s + (q || 0), 0)
  const merchandiseCost = totalQty * unitCost
  const totalCost = merchandiseCost + freightTotal + taxTotal
  const costPerUnit = totalQty > 0 ? totalCost / totalQty : 0

  const activeItems = useMemo(
    () =>
      Object.entries(quantities)
        .filter(([, qty]) => (qty ?? 0) > 0)
        .map(([id, quantity]) => ({ product_variation_id: Number(id), quantity })),
    [quantities]
  )

  // ── Handlers ─────────────────────────────────────────────────────────────────
  function setQty(variationId: number, value: string) {
    const n = parseInt(value, 10)
    setQuantities((prev) => ({
      ...prev,
      [variationId]: isNaN(n) || n < 0 ? 0 : n,
    }))
  }

  const onSubmit = async () => {
    if (activeItems.length === 0) {
      toast.error('Informe a quantidade de ao menos uma variação.')
      return
    }
    if (unitCost <= 0) {
      toast.error('Informe o custo unitário (R$).')
      return
    }
    if (!entryDate) {
      toast.error('Informe a data de entrada.')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/estoque/entrada/massa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: activeItems,
          supplier_id: supplierId,
          entry_type: entryType,
          unit_cost: unitCost,
          freight_cost_total: freightTotal,
          tax_cost_total: taxTotal,
          entry_date: entryDate,
          notes: notes || null,
        }),
      })

      const json = await res.json()

      if (!res.ok && res.status !== 207) {
        throw new Error(
          typeof json.error === 'string' ? json.error : 'Erro ao registrar entrada em massa.'
        )
      }

      if (res.status === 207) {
        const failed: { product_variation_id: number; error?: string }[] = json.results.filter(
          (r: { ok: boolean }) => !r.ok
        )
        const succeeded: number = json.totalItems
        toast.warning(
          `${succeeded} variação(ões) registrada(s), ${failed.length} com erro.`,
          {
            description: failed
              .slice(0, 3)
              .map((f) => `ID ${f.product_variation_id}: ${f.error}`)
              .join(' · '),
          }
        )
      } else {
        toast.success(
          `Entrada registrada para ${json.totalItems} variação(ões) — ${json.totalQty} unidades no total.`
        )
        router.push('/estoque')
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro desconhecido')
    } finally {
      setSubmitting(false)
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Cabeçalho */}
      <div className="flex items-center gap-3">
        <Link href="/estoque">
          <button className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Entrada em Matriz</h2>
          <p className="text-sm text-text-muted">
            Entrada de estoque por grade — distribui frete e impostos proporcionalmente
          </p>
        </div>
      </div>

      {/* Produto e fornecedor */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Package className="w-4 h-4" />
            Produto e Fornecedor
          </h3>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label-base">Tipo de Entrada *</label>
                <select
                  className="input-base"
                  value={entryType}
                  onChange={(e) => setEntryType(e.target.value as 'purchase' | 'own_production')}
                >
                  <option value="purchase">Compra de Fornecedor</option>
                  <option value="own_production">Produção Própria</option>
                </select>
              </div>
              <div>
                <label className="label-base">Fornecedor</label>
                <select
                  className="input-base"
                  value={supplierId ?? ''}
                  onChange={(e) =>
                    setSupplierId(e.target.value ? Number(e.target.value) : null)
                  }
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
          </div>
        </CardContent>
      </Card>

      {/* Grade de quantidades */}
      {selectedProductId && (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <Grid3X3 className="w-4 h-4" />
              Grade de Quantidades
            </h3>
          </CardHeader>
          <CardContent>
            {loadingVariations ? (
              <p className="text-sm text-text-muted py-2">Carregando variações...</p>
            ) : variations.length === 0 ? (
              <p className="text-sm text-text-muted py-2">
                Nenhuma variação ativa encontrada para este produto.
              </p>
            ) : hasBoth ? (
              /* ── Grade completa: cor × tamanho ── */
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-text-muted border-b border-border">
                        Cor \ Tam.
                      </th>
                      {sizes.map((s) => (
                        <th
                          key={s.id}
                          className="px-3 py-2 text-center text-xs font-medium text-text-muted border-b border-border min-w-[72px]"
                        >
                          {s.value}
                        </th>
                      ))}
                      <th className="px-3 py-2 text-center text-xs font-medium text-text-muted border-b border-border">
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {colors.map((color) => {
                      const rowTotal = sizes.reduce((sum, size) => {
                        const vid = variationLookup.get(`${color.id}-${size.id}`)
                        return sum + (vid ? (quantities[vid] ?? 0) : 0)
                      }, 0)

                      return (
                        <tr key={color.id} className="border-b border-border last:border-0">
                          <td className="px-3 py-2 text-xs font-medium text-text-primary whitespace-nowrap">
                            {color.value}
                          </td>
                          {sizes.map((size) => {
                            const vid = variationLookup.get(`${color.id}-${size.id}`)
                            return (
                              <td key={size.id} className="px-2 py-1.5 text-center">
                                {vid ? (
                                  <input
                                    type="number"
                                    min="0"
                                    value={quantities[vid] > 0 ? quantities[vid] : ''}
                                    onChange={(e) => setQty(vid, e.target.value)}
                                    className="w-16 text-center input-base py-1 text-sm"
                                    placeholder="0"
                                  />
                                ) : (
                                  <span className="text-text-disabled text-xs">—</span>
                                )}
                              </td>
                            )
                          })}
                          <td className="px-3 py-2 text-center text-sm font-semibold text-text-primary">
                            {rowTotal > 0 ? rowTotal : (
                              <span className="text-text-disabled font-normal">—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-border bg-bg-overlay">
                      <td className="px-3 py-2 text-xs font-semibold text-text-muted">Total</td>
                      {sizes.map((size) => {
                        const colTotal = colors.reduce((sum, color) => {
                          const vid = variationLookup.get(`${color.id}-${size.id}`)
                          return sum + (vid ? (quantities[vid] ?? 0) : 0)
                        }, 0)
                        return (
                          <td
                            key={size.id}
                            className="px-3 py-2 text-center text-sm font-semibold text-text-primary"
                          >
                            {colTotal > 0 ? colTotal : (
                              <span className="text-text-disabled font-normal">—</span>
                            )}
                          </td>
                        )
                      })}
                      <td className="px-3 py-2 text-center text-sm font-bold text-text-primary">
                        {totalQty > 0 ? totalQty : '—'}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              /* ── Lista única (só cor ou só tamanho ou sem atributos) ── */
              <div className="space-y-2">
                <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 items-center pb-2 border-b border-border">
                  <span className="text-xs font-medium text-text-muted">
                    {hasColors ? 'Cor' : hasSizes ? 'Tamanho' : 'Variação'}
                  </span>
                  <span className="text-xs font-medium text-text-muted w-28">SKU</span>
                  <span className="text-xs font-medium text-text-muted w-20 text-center">Qtd</span>
                </div>
                {variations.map((v) => {
                  const label =
                    v.product_variation_attributes
                      .map((a) => a.variation_values?.value)
                      .filter(Boolean)
                      .join(' / ') || v.sku_variation
                  return (
                    <div
                      key={v.id}
                      className="grid grid-cols-[1fr_auto_auto] gap-x-4 items-center py-1"
                    >
                      <span className="text-sm text-text-primary">{label}</span>
                      <code className="text-xs text-text-muted w-28 truncate">{v.sku_variation}</code>
                      <input
                        type="number"
                        min="0"
                        value={quantities[v.id] > 0 ? quantities[v.id] : ''}
                        onChange={(e) => setQty(v.id, e.target.value)}
                        className="w-20 text-center input-base py-1 text-sm"
                        placeholder="0"
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Custos e data */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Calculator className="w-4 h-4" />
            Custos e Data
          </h3>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Input
              label="Custo Unitário (R$) *"
              type="number"
              step="0.01"
              min="0"
              value={unitCost > 0 ? unitCost : ''}
              onChange={(e) => setUnitCost(parseFloat(e.target.value) || 0)}
              placeholder="0,00"
            />
            <Input
              label="Frete Total (R$)"
              type="number"
              step="0.01"
              min="0"
              value={freightTotal > 0 ? freightTotal : ''}
              onChange={(e) => setFreightTotal(parseFloat(e.target.value) || 0)}
              placeholder="0,00"
            />
            <Input
              label="Impostos Total (R$)"
              type="number"
              step="0.01"
              min="0"
              value={taxTotal > 0 ? taxTotal : ''}
              onChange={(e) => setTaxTotal(parseFloat(e.target.value) || 0)}
              placeholder="0,00"
            />
            <Input
              label="Data de Entrada *"
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
            />
          </div>

          <div>
            <label className="label-base">Observações</label>
            <textarea
              className="input-base resize-none"
              rows={2}
              placeholder="Notas opcionais sobre este lote (ex: NF 001234)..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {/* Preview de custo */}
          {totalQty > 0 && (
            <div className="p-3 rounded-lg bg-bg-overlay border border-border space-y-1.5">
              <p className="text-xs font-medium text-text-muted mb-1">
                Resumo do lote
              </p>
              <div className="flex justify-between text-xs text-text-muted">
                <span>
                  Mercadoria ({totalQty} un × {formatCurrency(unitCost)})
                </span>
                <span>{formatCurrency(merchandiseCost)}</span>
              </div>
              {freightTotal > 0 && (
                <div className="flex justify-between text-xs text-text-muted">
                  <span>Frete (distribuído por quantidade)</span>
                  <span>{formatCurrency(freightTotal)}</span>
                </div>
              )}
              {taxTotal > 0 && (
                <div className="flex justify-between text-xs text-text-muted">
                  <span>Impostos (distribuídos por quantidade)</span>
                  <span>{formatCurrency(taxTotal)}</span>
                </div>
              )}
              <div className="flex justify-between text-sm font-semibold text-text-primary border-t border-border pt-1.5">
                <span>Custo total do lote</span>
                <span>{formatCurrency(totalCost)}</span>
              </div>
              <div className="flex justify-between text-xs font-medium text-success">
                <span>Custo médio por unidade</span>
                <span>{formatCurrency(costPerUnit)}</span>
              </div>
              <div className="flex justify-between text-xs text-text-muted">
                <span>Variações com quantidade informada</span>
                <span>{activeItems.length}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Ações */}
      <div className="flex gap-3">
        <Button
          type="button"
          onClick={onSubmit}
          disabled={submitting || activeItems.length === 0}
        >
          {submitting
            ? 'Registrando...'
            : activeItems.length > 0
              ? `Registrar Entrada (${totalQty} un)`
              : 'Registrar Entrada'}
        </Button>
        <Link href="/estoque">
          <Button variant="secondary" type="button">
            Cancelar
          </Button>
        </Link>
      </div>
    </div>
  )
}
