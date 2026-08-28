'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { X, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { formatCurrency } from '@/lib/utils/currency'
import { ProductSearchInput } from '@/components/vendas/ProductSearchInput'
import type { ProductSearchItem } from '@/components/vendas/ProductSearchInput'
import type { SaleType } from '@/lib/pricing/resolveSalePrice'

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
  saleId:        number
  customerId:    number
  customerName:  string
  items:         ExchangeItem[]
  /**
   * PDV atacado/varejo (2026-09-02) — modalidade da venda ORIGINAL, herdada
   * pela troca (Fase 1 já garante isso no backend). Usada aqui só pra
   * buscar/precificar as peças novas na MESMA modalidade — nenhum seletor
   * livre que permita trocar a modalidade da venda-filha.
   */
  saleType: SaleType
}

// ── Componente ───────────────────────────────────────────────────────────────

export function ExchangeForm({ saleId, customerId, customerName, items, saleType }: Props) {
  const router = useRouter()

  // Seção 1: Devolvendo
  const [quantities, setQuantities] = useState<Record<number, number>>(
    Object.fromEntries(items.map(i => [i.id, 0]))
  )

  // Seção 2: Levando
  const [newItems, setNewItems] = useState<NewItem[]>([])

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
  function addNewItem(item: ProductSearchItem) {
    // PDV atacado/varejo (2026-09-02) — mesma defesa de vendas/nova: a
    // busca já bloqueia seleção sem preço de atacado, mas nunca confiar só
    // nisso antes de gravar unit_price.
    if (item.price == null) {
      toast.error('Preço de atacado não cadastrado', {
        description: `"${item.product_name}" não pode ser adicionado em atacado sem preço cadastrado.`,
      })
      return
    }
    const resolvedPrice = item.price // narrowed pra number aqui — usado abaixo em vez de item.price dentro do closure de setNewItems

    const variationParts = [item.cor, item.tamanho].filter(Boolean)
    const variationLabel = variationParts.length > 0 ? variationParts.join(' / ') : 'Padrão'

    setNewItems(prev => {
      const existing = prev.find(i => i.product_variation_id === item.variation_id)
      if (existing) {
        return prev.map(i =>
          i.product_variation_id === item.variation_id
            ? { ...i, quantity: Math.min(i.quantity + 1, i.current_qty) }
            : i
        )
      }
      return [...prev, {
        product_variation_id: item.variation_id,
        product_name:    item.product_name,
        sku_variation:   item.sku,
        variation_label: variationLabel,
        quantity:        1,
        unit_price:      resolvedPrice,
        current_qty:     item.stock,
      }]
    })
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
  async function doSubmit() {
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

  function handleSubmit() {
    if (!hasReturning) {
      toast.error('Selecione ao menos uma peça para devolver.')
      return
    }
    doSubmit()
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
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">Peça que a cliente vai levar</h2>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                saleType === 'wholesale' ? 'bg-purple-500/15 text-purple-400' : 'bg-blue-500/15 text-blue-400'
              }`}>
                {saleType === 'wholesale' ? 'ATACADO' : 'VAREJO'}
              </span>
            </div>
            <p className="text-sm text-text-muted">
              Opcional — deixe em branco para gerar só o crédito. Preço segue a modalidade da venda original.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">

            {/* Busca */}
            <ProductSearchInput onSelect={addNewItem} saleType={saleType} />

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
                  <span className="text-text-primary">A cobrar ({PAYMENT_LABELS[paymentMethod] ?? paymentMethod})</span>
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
