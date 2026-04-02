'use client'

import { useState, useEffect, useMemo, useCallback, useId } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft,
  Calculator,
  Package,
  Plus,
  Trash2,
  Grid3X3,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { formatCurrency } from '@/lib/utils/currency'

// ─── Tipos ────────────────────────────────────────────────────────────────────

type ProductMeta = { id: number; name: string; sku: string }
type SupplierMeta = { id: number; name: string }

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

type AttrValue = { id: number; value: string }

/** Estado de um bloco de produto dentro do lote. */
type ProductBlock = {
  blockId: string
  productId: number | null
  unitCost: number
  quantities: Record<number, number>   // variationId → qty
  variations: Variation[]
  loading: boolean
  collapsed: boolean
}

// ─── Helpers de grade ─────────────────────────────────────────────────────────

function buildGrid(variations: Variation[]) {
  const colorMap = new Map<number, string>()
  const sizeMap = new Map<number, string>()
  const lookup = new Map<string, number>()   // `${colorId}-${sizeId}` → variationId

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

  return { colors, sizes, lookup }
}

function blockTotalQty(block: ProductBlock) {
  return Object.values(block.quantities).reduce((s, q) => s + (q || 0), 0)
}

// ─── Componente do bloco de produto ──────────────────────────────────────────

function ProductBlockCard({
  block,
  products,
  index,
  onProductChange,
  onQtyChange,
  onUnitCostChange,
  onToggleCollapse,
  onRemove,
}: {
  block: ProductBlock
  products: ProductMeta[]
  index: number
  onProductChange: (blockId: string, productId: number | null) => void
  onQtyChange: (blockId: string, variationId: number, value: string) => void
  onUnitCostChange: (blockId: string, value: string) => void
  onToggleCollapse: (blockId: string) => void
  onRemove: (blockId: string) => void
}) {
  const { colors, sizes, lookup } = useMemo(() => buildGrid(block.variations), [block.variations])
  const hasBoth = colors.length > 0 && sizes.length > 0
  const hasColors = colors.length > 0
  const hasSizes = sizes.length > 0
  const totalQty = blockTotalQty(block)
  const selectedProduct = products.find((p) => p.id === block.productId)

  return (
    <Card>
      {/* Cabeçalho do bloco */}
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Package className="w-4 h-4 shrink-0 text-text-muted" />
            <span className="text-sm font-semibold text-text-primary truncate">
              {selectedProduct
                ? `${selectedProduct.name} — ${selectedProduct.sku}`
                : `Produto ${index + 1}`}
            </span>
            {totalQty > 0 && (
              <span className="shrink-0 text-xs bg-bg-overlay border border-border rounded-full px-2 py-0.5 text-text-muted">
                {totalQty} un
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => onToggleCollapse(block.blockId)}
              className="p-1.5 rounded-lg hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors"
              title={block.collapsed ? 'Expandir' : 'Recolher'}
            >
              {block.collapsed ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronUp className="w-4 h-4" />
              )}
            </button>
            <button
              type="button"
              onClick={() => onRemove(block.blockId)}
              className="p-1.5 rounded-lg hover:bg-error/10 text-text-muted hover:text-error transition-colors"
              title="Remover produto"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </CardHeader>

      {!block.collapsed && (
        <CardContent className="space-y-4">
          {/* Seletor de produto + custo unitário */}
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_160px] gap-4">
            <div>
              <label className="label-base">Produto *</label>
              <select
                className="input-base"
                value={block.productId ?? ''}
                onChange={(e) =>
                  onProductChange(block.blockId, e.target.value ? Number(e.target.value) : null)
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
            <Input
              label="Custo Unitário (R$) *"
              type="number"
              step="0.01"
              min="0"
              value={block.unitCost > 0 ? block.unitCost : ''}
              onChange={(e) => onUnitCostChange(block.blockId, e.target.value)}
              placeholder="0,00"
            />
          </div>

          {/* Grade de variações */}
          {block.productId && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Grid3X3 className="w-3.5 h-3.5 text-text-muted" />
                <span className="text-xs font-medium text-text-muted">Grade de Quantidades</span>
              </div>

              {block.loading ? (
                <p className="text-sm text-text-muted">Carregando variações...</p>
              ) : block.variations.length === 0 ? (
                <p className="text-sm text-text-muted">
                  Nenhuma variação ativa encontrada.
                </p>
              ) : hasBoth ? (
                /* Grade completa: cor × tamanho */
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
                          const vid = lookup.get(`${color.id}-${size.id}`)
                          return sum + (vid ? (block.quantities[vid] ?? 0) : 0)
                        }, 0)
                        return (
                          <tr key={color.id} className="border-b border-border last:border-0">
                            <td className="px-3 py-2 text-xs font-medium text-text-primary whitespace-nowrap">
                              {color.value}
                            </td>
                            {sizes.map((size) => {
                              const vid = lookup.get(`${color.id}-${size.id}`)
                              return (
                                <td key={size.id} className="px-2 py-1.5 text-center">
                                  {vid ? (
                                    <input
                                      type="number"
                                      min="0"
                                      value={block.quantities[vid] > 0 ? block.quantities[vid] : ''}
                                      onChange={(e) =>
                                        onQtyChange(block.blockId, vid, e.target.value)
                                      }
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
                            const vid = lookup.get(`${color.id}-${size.id}`)
                            return sum + (vid ? (block.quantities[vid] ?? 0) : 0)
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
                /* Lista simples (só cor, só tamanho, ou sem atributos) */
                <div className="space-y-2">
                  <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 items-center pb-2 border-b border-border">
                    <span className="text-xs font-medium text-text-muted">
                      {hasColors ? 'Cor' : hasSizes ? 'Tamanho' : 'Variação'}
                    </span>
                    <span className="text-xs font-medium text-text-muted w-28">SKU</span>
                    <span className="text-xs font-medium text-text-muted w-20 text-center">Qtd</span>
                  </div>
                  {block.variations.map((v) => {
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
                        <code className="text-xs text-text-muted w-28 truncate">
                          {v.sku_variation}
                        </code>
                        <input
                          type="number"
                          min="0"
                          value={block.quantities[v.id] > 0 ? block.quantities[v.id] : ''}
                          onChange={(e) => onQtyChange(block.blockId, v.id, e.target.value)}
                          className="w-20 text-center input-base py-1 text-sm"
                          placeholder="0"
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

let _blockCounter = 0
function newBlockId() {
  return `block-${++_blockCounter}`
}

function createEmptyBlock(): ProductBlock {
  return {
    blockId: newBlockId(),
    productId: null,
    unitCost: 0,
    quantities: {},
    variations: [],
    loading: false,
    collapsed: false,
  }
}

export default function EstoqueEntradaLotePage() {
  const router = useRouter()
  const supabase = createClient()
  const uid = useId()

  // ── Dados base ──────────────────────────────────────────────────────────────
  const [products, setProducts] = useState<ProductMeta[]>([])
  const [suppliers, setSuppliers] = useState<SupplierMeta[]>([])

  // ── Cabeçalho do lote ───────────────────────────────────────────────────────
  const [supplierId, setSupplierId] = useState<number | null>(null)
  const [entryType, setEntryType] = useState<'purchase' | 'own_production'>('purchase')
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10))
  const [freightTotal, setFreightTotal] = useState(0)
  const [taxTotal, setTaxTotal] = useState(0)
  const [notes, setNotes] = useState('')

  // ── Blocos de produto ───────────────────────────────────────────────────────
  const [blocks, setBlocks] = useState<ProductBlock[]>([createEmptyBlock()])

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

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const handleProductChange = useCallback(
    (blockId: string, productId: number | null) => {
      // Optimistic update: set productId + start loading
      setBlocks((prev) =>
        prev.map((b) =>
          b.blockId === blockId
            ? { ...b, productId, variations: [], quantities: {}, loading: !!productId }
            : b
        )
      )

      if (!productId) return

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
        .eq('product_id', productId)
        .eq('active', true)
        .then(({ data }) => {
          setBlocks((prev) =>
            prev.map((b) =>
              b.blockId === blockId
                ? { ...b, variations: (data as unknown as Variation[]) ?? [], loading: false }
                : b
            )
          )
        })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const handleQtyChange = useCallback(
    (blockId: string, variationId: number, value: string) => {
      const n = parseInt(value, 10)
      setBlocks((prev) =>
        prev.map((b) =>
          b.blockId === blockId
            ? { ...b, quantities: { ...b.quantities, [variationId]: isNaN(n) || n < 0 ? 0 : n } }
            : b
        )
      )
    },
    []
  )

  const handleUnitCostChange = useCallback((blockId: string, value: string) => {
    const n = parseFloat(value)
    setBlocks((prev) =>
      prev.map((b) =>
        b.blockId === blockId ? { ...b, unitCost: isNaN(n) || n < 0 ? 0 : n } : b
      )
    )
  }, [])

  const handleToggleCollapse = useCallback((blockId: string) => {
    setBlocks((prev) =>
      prev.map((b) => (b.blockId === blockId ? { ...b, collapsed: !b.collapsed } : b))
    )
  }, [])

  const handleRemove = useCallback((blockId: string) => {
    setBlocks((prev) => {
      if (prev.length === 1) return prev   // always keep at least one block
      return prev.filter((b) => b.blockId !== blockId)
    })
  }, [])

  const handleAddBlock = useCallback(() => {
    setBlocks((prev) => [...prev, createEmptyBlock()])
  }, [])

  // ── Totais derivados ─────────────────────────────────────────────────────────

  const { allItems, totalQty, totalMerchandiseCost, totalProducts } = useMemo(() => {
    type FlatItem = { product_variation_id: number; quantity: number; unit_cost: number }
    const items: FlatItem[] = []
    let totalMerchandiseCost = 0
    const productIds = new Set<number>()

    for (const block of blocks) {
      if (!block.productId) continue
      for (const [vid, qty] of Object.entries(block.quantities)) {
        if ((qty ?? 0) <= 0) continue
        items.push({
          product_variation_id: Number(vid),
          quantity: qty,
          unit_cost: block.unitCost,
        })
        totalMerchandiseCost += qty * block.unitCost
        productIds.add(block.productId)
      }
    }

    const totalQty = items.reduce((s, i) => s + i.quantity, 0)
    return { allItems: items, totalQty, totalMerchandiseCost, totalProducts: productIds.size }
  }, [blocks])

  const totalCost = totalMerchandiseCost + freightTotal + taxTotal
  const avgCostPerUnit = totalQty > 0 ? totalCost / totalQty : 0

  // ── Submit ────────────────────────────────────────────────────────────────────

  const onSubmit = async () => {
    if (allItems.length === 0) {
      toast.error('Preencha a quantidade de ao menos uma variação em um produto.')
      return
    }

    const blocksWithCost = blocks.filter((b) => b.productId && blockTotalQty(b) > 0 && b.unitCost <= 0)
    if (blocksWithCost.length > 0) {
      const p = products.find((p) => p.id === blocksWithCost[0].productId)
      toast.error(`Informe o custo unitário do produto "${p?.name ?? blocksWithCost[0].productId}".`)
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
          items: allItems,
          supplier_id: supplierId,
          entry_type: entryType,
          unit_cost: 0,   // each item carries its own unit_cost
          freight_cost_total: freightTotal,
          tax_cost_total: taxTotal,
          entry_date: entryDate,
          notes: notes || null,
        }),
      })

      const json = await res.json()

      if (!res.ok && res.status !== 207) {
        throw new Error(
          typeof json.error === 'string' ? json.error : 'Erro ao registrar entrada em lote.'
        )
      }

      if (res.status === 207) {
        const failed: { product_variation_id: number; error?: string }[] = json.results.filter(
          (r: { ok: boolean }) => !r.ok
        )
        toast.warning(
          `${json.totalItems} variação(ões) registrada(s), ${failed.length} com erro.`,
          {
            description: failed
              .slice(0, 3)
              .map((f) => `ID ${f.product_variation_id}: ${f.error}`)
              .join(' · '),
          }
        )
      } else {
        toast.success(
          `Lote registrado — ${json.totalItems} variações, ${json.totalQty} unidades no total.`
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
      {/* Cabeçalho da página */}
      <div className="flex items-center gap-3">
        <Link href="/estoque">
          <button className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Entrada em Lote</h2>
          <p className="text-sm text-text-muted">
            Múltiplos produtos num único lançamento — frete e impostos rateados pelo total de peças
          </p>
        </div>
      </div>

      {/* Cabeçalho do lote */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Calculator className="w-4 h-4" />
            Dados do Lote
          </h3>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="label-base" htmlFor={`${uid}-supplier`}>Fornecedor</label>
              <select
                id={`${uid}-supplier`}
                className="input-base"
                value={supplierId ?? ''}
                onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Sem fornecedor</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="label-base" htmlFor={`${uid}-type`}>Tipo de Entrada *</label>
              <select
                id={`${uid}-type`}
                className="input-base"
                value={entryType}
                onChange={(e) => setEntryType(e.target.value as 'purchase' | 'own_production')}
              >
                <option value="purchase">Compra de Fornecedor</option>
                <option value="own_production">Produção Própria</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
            <label className="label-base" htmlFor={`${uid}-notes`}>Observações</label>
            <textarea
              id={`${uid}-notes`}
              className="input-base resize-none"
              rows={2}
              placeholder="Ex: NF 001234, remessa parcial..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Blocos de produto */}
      {blocks.map((block, index) => (
        <ProductBlockCard
          key={block.blockId}
          block={block}
          products={products}
          index={index}
          onProductChange={handleProductChange}
          onQtyChange={handleQtyChange}
          onUnitCostChange={handleUnitCostChange}
          onToggleCollapse={handleToggleCollapse}
          onRemove={handleRemove}
        />
      ))}

      {/* Botão adicionar produto */}
      <button
        type="button"
        onClick={handleAddBlock}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-dashed border-border text-sm text-text-muted hover:border-primary hover:text-primary hover:bg-primary/5 transition-colors"
      >
        <Plus className="w-4 h-4" />
        Adicionar produto ao lote
      </button>

      {/* Preview do lote */}
      {totalQty > 0 && (
        <Card>
          <CardContent className="pt-4 space-y-1.5">
            <p className="text-xs font-semibold text-text-muted mb-2">Resumo do lote</p>
            <div className="flex justify-between text-xs text-text-muted">
              <span>Produtos distintos</span>
              <span>{totalProducts}</span>
            </div>
            <div className="flex justify-between text-xs text-text-muted">
              <span>Total de peças</span>
              <span>{totalQty}</span>
            </div>
            <div className="flex justify-between text-xs text-text-muted">
              <span>Mercadoria (custo × qtd por produto)</span>
              <span>{formatCurrency(totalMerchandiseCost)}</span>
            </div>
            {freightTotal > 0 && (
              <div className="flex justify-between text-xs text-text-muted">
                <span>Frete (rateado por peça)</span>
                <span>{formatCurrency(freightTotal)}</span>
              </div>
            )}
            {taxTotal > 0 && (
              <div className="flex justify-between text-xs text-text-muted">
                <span>Impostos (rateados por peça)</span>
                <span>{formatCurrency(taxTotal)}</span>
              </div>
            )}
            <div className="flex justify-between text-sm font-semibold text-text-primary border-t border-border pt-2 mt-1">
              <span>Custo total do lote</span>
              <span>{formatCurrency(totalCost)}</span>
            </div>
            <div className="flex justify-between text-xs font-medium text-success">
              <span>Custo médio por peça (com rateio)</span>
              <span>{formatCurrency(avgCostPerUnit)}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Ações */}
      <div className="flex gap-3 pb-6">
        <Button
          type="button"
          onClick={onSubmit}
          disabled={submitting || allItems.length === 0}
        >
          {submitting
            ? 'Registrando...'
            : allItems.length > 0
              ? `Registrar Lote (${totalQty} un)`
              : 'Registrar Lote'}
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
