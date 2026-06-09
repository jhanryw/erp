'use client'

import { useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Search, X, Plus, RefreshCw, ArrowRightLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { formatCurrency } from '@/lib/utils/currency'

// ── Tipos ────────────────────────────────────────────────────────────────────

type ExchangeItem = {
  id: number
  quantity: number
  unit_price: number
  already_returned: number
  available_to_return: number
  product_variations: {
    id: number
    sku_variation: string
    products: { id: number; name: string }
    product_variation_attributes: {
      variation_types: { slug: string; name: string }
      variation_values: { value: string }
    }[]
  } | null
}

type StockItem = {
  product_variation_id: number
  product_name: string
  sku_variation: string
  cor: string | null
  tamanho: string | null
  price: number
  current_qty: number
}

type NewItem = {
  product_variation_id: number
  product_name: string
  sku_variation: string
  variation_label: string
  quantity: number
  unit_price: number
  current_qty: number
}

const PAYMENT_LABELS: Record<string, string> = {
  cash:        'Dinheiro',
  pix:         'PIX',
  credit_card: 'Cartão de Crédito',
  debit_card:  'Cartão de Débito',
}

interface Props {
  saleId: number
  customerId: number
  customerName: string
  items: ExchangeItem[]
}

// ── Componente ───────────────────────────────────────────────────────────────

export function ExchangeForm({ saleId, customerId, customerName, items }: Props) {
  const router = useRouter()

  // Seção 1: Devolvendo
  const [quantities, setQuantities] = useState<Record<number, number>>(
    Object.fromEntries(items.map(i => [i.id, 0]))
  )

  // Seção 2: Levando
  const [newItems, setNewItems] = useState<NewItem[]>([])
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<StockItem[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Seção 3: Pagamento (se diferença > crédito)
  const [paymentMethod, setPaymentMethod] = useState<string>('pix')

  // Observações
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)

  const availableItems = items.filter(i => i.available_to_return > 0)

  // ── Cálculos ─────────────────────────────────────────────────────────────
  const creditAmount = availableItems.reduce((sum, item) => {
    const qty = quantities[item.id] ?? 0
    return sum + qty * Number(item.unit_price)
  }, 0)

  const newItemsTotal = newItems.reduce((sum, i) => sum + i.quantity * i.unit_price, 0)
  const cashbackToUse = Math.min(creditAmount, newItemsTotal)
  const toPay        = Math.max(0, newItemsTotal - creditAmount)
  const remainCredit = Math.max(0, creditAmount - newItemsTotal)
  const hasReturning = Object.values(quantities).some(q => q > 0)

  // ── Busca de produtos ─────────────────────────────────────────────────────
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (value.length < 2) { setSearchResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setSearchLoading(true)
      try {
        const res = await fetch(`/api/troca/produtos?q=${encodeURIComponent(value)}`)
        const json = await res.json()
        setSearchResults(json.items ?? [])
      } catch {
        setSearchResults([])
      } finally {
        setSearchLoading(false)
      }
    }, 300)
  }, [])

  function addNewItem(stock: StockItem) {
    const variationParts = [stock.cor, stock.tamanho].filter(Boolean)
    const variationLabel = variationParts.length > 0 ? variationParts.join(' / ') : 'Padrão'

    setNewItems(prev => {
      const existing = prev.find(i => i.product_variation_id === stock.product_variation_id)
      if (existing) {
        return prev.map(i =>
          i.product_variation_id === stock.product_variation_id
            ? { ...i, quantity: Math.min(i.quantity + 1, i.current_qty) }
            : i
        )
      }
      return [...prev, {
        product_variation_id: stock.product_variation_id,
        product_name:  stock.product_name,
        sku_variation: stock.sku_variation,
        variation_label: variationLabel,
        quantity:   1,
        unit_price: Number(stock.price),
        current_qty: Number(stock.current_qty),
      }]
    })
    setSearch('')
    setSearchResults([])
  }

  function removeNewItem(pvid: number) {
    setNewItems(prev => prev.filter(i => i.product_variation_id !== pvid))
  }

  function setNewItemQty(pvid: number, qty: number, max: number) {
    if (qty <= 0) { removeNewItem(pvid); return }
    setNewItems(prev =>
      prev.map(i =>
        i.product_variation_id === pvid
          ? { ...i, quantity: Math.min(qty, max) }
          : i
      )
    )
  }

  function getVariation(item: ExchangeItem): string {
    const attrs = item.product_variations?.product_variation_attributes ?? []
    return attrs.map(a => a.variation_values?.value).filter(Boolean).join(' / ')
  }

  function setQty(itemId: number, value: number, max: number) {
    setQuantities(prev => ({ ...prev, [itemId]: Math.max(0, Math.min(max, value)) }))
  }

  // ── Submeter ─────────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (!hasReturning) {
      toast.error('Selecione ao menos uma peça para devolver.')
      return
    }

    const selectedItems = availableItems
      .filter(i => (quantities[i.id] ?? 0) > 0)
      .map(i => ({ sale_item_id: i.id, quantity_returned: quantities[i.id] }))

    const payload: Record<string, unknown> = {
      customer_id: customerId,
      items:       selectedItems,
      notes:       notes.trim() || undefined,
    }

    if (newItems.length > 0) {
      payload.new_items = newItems.map(i => ({
        product_variation_id: i.product_variation_id,
        quantity:             i.quantity,
        unit_price:           i.unit_price,
      }))
      if (toPay > 0.009) {
        payload.payment_method = paymentMethod
      }
    }

    setLoading(true)
    try {
      const res = await fetch(`/api/vendas/${saleId}/troca`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })

      const json = await res.json()

      if (!res.ok) {
        toast.error('Erro ao registrar troca', { description: json.error })
        return
      }

      if (json.new_sale_error) {
        toast.warning(json.new_sale_error)
      } else if (json.new_sale_number) {
        toast.success('Troca concluída!', {
          description: `Crédito de ${formatCurrency(json.credit_amount)} gerado · Nova venda ${json.new_sale_number} criada.`,
          duration: 8000,
        })
      } else {
        toast.success('Troca registrada!', {
          description: `Crédito de ${formatCurrency(json.credit_amount)} disponível para ${customerName}.`,
          duration: 6000,
        })
      }

      router.push(`/vendas/${saleId}`)
    } finally {
      setLoading(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">

      {/* ── SEÇÃO 1: Devolvendo ──────────────────────────────── */}
      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold">Peças que a cliente está devolvendo</h2>
          <p className="text-sm text-text-muted">Selecione e defina a quantidade</p>
        </CardHeader>
        <CardContent className="space-y-0 divide-y divide-border">
          {availableItems.map(item => {
            const qty = quantities[item.id] ?? 0
            const lineTotal = qty * Number(item.unit_price)
            const variation = getVariation(item)
            const isSelected = qty > 0

            return (
              <div key={item.id} className={`py-4 transition-colors ${isSelected ? 'bg-brand/5' : ''}`}>
                <div className="flex items-start gap-4">
                  <button
                    type="button"
                    onClick={() => setQty(item.id, isSelected ? 0 : item.available_to_return, item.available_to_return)}
                    className={`mt-0.5 w-5 h-5 rounded border-2 flex-shrink-0 flex items-center justify-center transition-colors ${
                      isSelected ? 'bg-brand border-brand' : 'border-border bg-bg-input'
                    }`}
                  >
                    {isSelected && (
                      <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 12 12">
                        <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </button>

                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-text-primary">{item.product_variations?.products?.name ?? '—'}</p>
                    {variation && <p className="text-sm text-text-muted">{variation}</p>}
                    <p className="text-xs text-text-muted font-mono mt-0.5">{item.product_variations?.sku_variation}</p>
                    <div className="flex flex-wrap gap-3 mt-1.5 text-xs text-text-muted">
                      <span>Qtd original: <strong className="text-text-secondary">{item.quantity}</strong></span>
                      {item.already_returned > 0 && <span className="text-warning">Já trocado: {item.already_returned}</span>}
                      <span>Disponível: <strong className="text-text-secondary">{item.available_to_return}</strong></span>
                      <span>{formatCurrency(item.unit_price)}/un</span>
                    </div>
                  </div>

                  <div className="flex-shrink-0 flex flex-col items-end gap-2">
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => setQty(item.id, qty - 1, item.available_to_return)} disabled={qty === 0}
                        className="w-7 h-7 rounded border border-border bg-bg-subtle flex items-center justify-center text-text-secondary hover:bg-bg-hover disabled:opacity-30 text-lg leading-none">−</button>
                      <span className="w-8 text-center font-mono font-medium text-text-primary">{qty}</span>
                      <button type="button" onClick={() => setQty(item.id, qty + 1, item.available_to_return)} disabled={qty >= item.available_to_return}
                        className="w-7 h-7 rounded border border-border bg-bg-subtle flex items-center justify-center text-text-secondary hover:bg-bg-hover disabled:opacity-30 text-lg leading-none">+</button>
                    </div>
                    {lineTotal > 0 && <span className="text-sm font-semibold text-success">{formatCurrency(lineTotal)}</span>}
                  </div>
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      {/* ── SEÇÃO 2: Levando (Nova Peça) ────────────────────── */}
      {hasReturning && (
        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold">Peça que a cliente vai levar</h2>
            <p className="text-sm text-text-muted">Opcional — deixe em branco para gerar só o crédito</p>
          </CardHeader>
          <CardContent className="space-y-4">

            {/* Busca */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                type="search"
                placeholder="Buscar peça por nome ou SKU..."
                value={search}
                onChange={e => handleSearchChange(e.target.value)}
                className="pl-9"
              />

              {/* Dropdown de resultados */}
              {(searchResults.length > 0 || searchLoading) && (
                <div className="absolute top-full left-0 right-0 z-50 mt-1 rounded-xl border border-border bg-bg-card shadow-xl max-h-64 overflow-y-auto">
                  {searchLoading && (
                    <div className="px-4 py-3 text-sm text-text-muted">Buscando...</div>
                  )}
                  {searchResults.map(item => {
                    const variationParts = [item.cor, item.tamanho].filter(Boolean)
                    const variationLabel = variationParts.join(' / ') || 'Padrão'
                    const alreadyAdded = newItems.some(i => i.product_variation_id === item.product_variation_id)
                    return (
                      <button
                        key={item.product_variation_id}
                        type="button"
                        onClick={() => addNewItem(item)}
                        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-bg-hover transition-colors text-left border-b border-border last:border-0"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-text-primary truncate">{item.product_name}</p>
                          <p className="text-xs text-text-muted">{variationLabel} · {item.sku_variation}</p>
                        </div>
                        <div className="flex-shrink-0 text-right">
                          <p className="text-sm font-semibold text-text-primary">{formatCurrency(item.price)}</p>
                          <p className="text-xs text-text-muted">{item.current_qty} em estoque</p>
                        </div>
                        {alreadyAdded && (
                          <Plus className="w-4 h-4 text-brand flex-shrink-0" />
                        )}
                      </button>
                    )
                  })}
                  {!searchLoading && searchResults.length === 0 && search.length >= 2 && (
                    <div className="px-4 py-3 text-sm text-text-muted">Nenhuma peça encontrada.</div>
                  )}
                </div>
              )}
            </div>

            {/* Itens selecionados */}
            {newItems.length > 0 && (
              <div className="space-y-2">
                {newItems.map(item => (
                  <div key={item.product_variation_id}
                    className="flex items-center gap-3 rounded-lg border border-border bg-bg-subtle px-3 py-2.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text-primary truncate">{item.product_name}</p>
                      <p className="text-xs text-text-muted">{item.variation_label} · {item.sku_variation}</p>
                    </div>

                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button type="button" onClick={() => setNewItemQty(item.product_variation_id, item.quantity - 1, item.current_qty)}
                        className="w-6 h-6 rounded border border-border bg-bg-input flex items-center justify-center text-text-secondary hover:bg-bg-hover text-base leading-none">−</button>
                      <span className="w-7 text-center font-mono text-sm font-medium">{item.quantity}</span>
                      <button type="button" onClick={() => setNewItemQty(item.product_variation_id, item.quantity + 1, item.current_qty)}
                        disabled={item.quantity >= item.current_qty}
                        className="w-6 h-6 rounded border border-border bg-bg-input flex items-center justify-center text-text-secondary hover:bg-bg-hover disabled:opacity-30 text-base leading-none">+</button>
                    </div>

                    <span className="text-sm font-semibold text-text-primary tabular-nums w-20 text-right flex-shrink-0">
                      {formatCurrency(item.quantity * item.unit_price)}
                    </span>

                    <button type="button" onClick={() => removeNewItem(item.product_variation_id)}
                      className="w-6 h-6 flex-shrink-0 flex items-center justify-center rounded hover:bg-error/10 text-text-muted hover:text-error transition-colors">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Observações ─────────────────────────────────────── */}
      {hasReturning && (
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-text-secondary">Observações (opcional)</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Ex: tamanho errado, cor diferente..."
            maxLength={500}
            rows={2}
            className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand/40 resize-none"
          />
        </div>
      )}

      {/* ── SEÇÃO 3: Forma de pagamento (se tiver diferença) ─ */}
      {hasReturning && newItems.length > 0 && toPay > 0.009 && (
        <Card padding="md">
          <h3 className="text-sm font-semibold text-text-primary mb-3">
            Forma de pagamento — diferença de {formatCurrency(toPay)}
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(PAYMENT_LABELS).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setPaymentMethod(value)}
                className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  paymentMethod === value
                    ? 'bg-brand text-white border-brand'
                    : 'border-border text-text-secondary hover:bg-bg-hover'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* ── SEÇÃO 4: Resumo + Confirmar ─────────────────────── */}
      {hasReturning && (
        <Card padding="md">
          <div className="space-y-2 text-sm mb-4">
            <div className="flex justify-between text-text-muted">
              <span>Crédito da devolução</span>
              <span className="text-success font-semibold">+ {formatCurrency(creditAmount)}</span>
            </div>
            {newItemsTotal > 0 && (
              <>
                <div className="flex justify-between text-text-muted">
                  <span>Nova(s) peça(s)</span>
                  <span className="text-text-secondary">− {formatCurrency(newItemsTotal)}</span>
                </div>
                {cashbackToUse > 0 && (
                  <div className="flex justify-between text-text-muted">
                    <span>Crédito usado na troca</span>
                    <span className="text-text-muted">− {formatCurrency(cashbackToUse)}</span>
                  </div>
                )}
              </>
            )}
            <div className="border-t border-border pt-2 mt-2 space-y-1.5">
              {toPay > 0.009 && (
                <div className="flex justify-between font-semibold">
                  <span className="text-text-primary">A cobrar ({PAYMENT_LABELS[paymentMethod]})</span>
                  <span className="text-warning text-base">{formatCurrency(toPay)}</span>
                </div>
              )}
              {remainCredit > 0.009 && (
                <div className="flex justify-between font-semibold">
                  <span className="text-text-primary">Crédito na carteira de {customerName}</span>
                  <span className="text-success text-base">{formatCurrency(remainCredit)}</span>
                </div>
              )}
              {newItemsTotal > 0 && toPay <= 0.009 && remainCredit <= 0.009 && (
                <div className="flex justify-between font-semibold text-success">
                  <span>Troca justa — sem diferença</span>
                  <span>✓</span>
                </div>
              )}
            </div>
          </div>

          <Button
            className="w-full"
            onClick={handleSubmit}
            disabled={!hasReturning || loading}
            loading={loading}
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            {newItems.length > 0
              ? toPay > 0.009
                ? `Confirmar Troca — Cobrar ${formatCurrency(toPay)}`
                : remainCredit > 0.009
                  ? `Confirmar Troca — Crédito de ${formatCurrency(remainCredit)}`
                  : 'Confirmar Troca'
              : `Confirmar e Gerar Crédito de ${formatCurrency(creditAmount)}`
            }
          </Button>
        </Card>
      )}
    </div>
  )
}
