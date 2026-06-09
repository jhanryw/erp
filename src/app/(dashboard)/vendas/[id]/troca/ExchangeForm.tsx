'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowRightLeft, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { formatCurrency } from '@/lib/utils/currency'

type ExchangeItem = {
  id: number
  quantity: number
  unit_price: number
  total_price: number
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

interface Props {
  saleId: number
  customerId: number
  customerName: string
  items: ExchangeItem[]
}

export function ExchangeForm({ saleId, customerId, customerName, items }: Props) {
  const router = useRouter()
  const [quantities, setQuantities] = useState<Record<number, number>>(
    Object.fromEntries(items.map(i => [i.id, 0]))
  )
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)

  // Itens com quantidade disponível para troca
  const availableItems = items.filter(i => i.available_to_return > 0)

  // Crédito total sendo gerado
  const totalCredit = availableItems.reduce((sum, item) => {
    const qty = quantities[item.id] ?? 0
    return sum + qty * Number(item.unit_price)
  }, 0)

  const hasSelection = Object.values(quantities).some(q => q > 0)

  function getVariation(item: ExchangeItem): string {
    const attrs = item.product_variations?.product_variation_attributes ?? []
    return attrs
      .map(a => a.variation_values?.value)
      .filter(Boolean)
      .join(' / ')
  }

  function setQty(itemId: number, value: number, max: number) {
    setQuantities(prev => ({ ...prev, [itemId]: Math.max(0, Math.min(max, value)) }))
  }

  async function handleSubmit() {
    if (!hasSelection) {
      toast.error('Selecione ao menos um item para trocar.')
      return
    }

    const selectedItems = availableItems
      .filter(i => (quantities[i.id] ?? 0) > 0)
      .map(i => ({
        sale_item_id:      i.id,
        quantity_returned: quantities[i.id],
      }))

    setLoading(true)
    try {
      const res = await fetch(`/api/vendas/${saleId}/troca`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: customerId,
          items:       selectedItems,
          notes:       notes.trim() || undefined,
        }),
      })

      const json = await res.json()

      if (!res.ok) {
        toast.error('Erro ao registrar troca', { description: json.error })
        return
      }

      toast.success('Troca registrada com sucesso!', {
        description: `Crédito de ${formatCurrency(json.credit_amount)} disponível para ${customerName}.`,
        duration: 6000,
      })
      router.push(`/vendas/${saleId}`)
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* Itens disponíveis */}
      <Card>
        <CardHeader>
          <h2 className="text-base font-semibold">Itens da venda</h2>
          <p className="text-sm text-text-muted">
            Selecione as peças que a cliente está devolvendo
          </p>
        </CardHeader>
        <CardContent className="space-y-0 divide-y divide-border">
          {availableItems.map(item => {
            const qty = quantities[item.id] ?? 0
            const lineTotal = qty * Number(item.unit_price)
            const variation = getVariation(item)
            const isSelected = qty > 0

            return (
              <div
                key={item.id}
                className={`py-4 transition-colors ${isSelected ? 'bg-brand/5' : ''}`}
              >
                <div className="flex items-start gap-4">
                  {/* Checkbox visual */}
                  <button
                    type="button"
                    onClick={() =>
                      setQty(item.id, isSelected ? 0 : item.available_to_return, item.available_to_return)
                    }
                    className={`mt-0.5 w-5 h-5 rounded border-2 flex-shrink-0 flex items-center justify-center transition-colors ${
                      isSelected
                        ? 'bg-brand border-brand'
                        : 'border-border bg-bg-input'
                    }`}
                  >
                    {isSelected && (
                      <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 12 12">
                        <path d="M10 3L5 8.5 2 5.5" stroke="white" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </button>

                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-text-primary">
                      {item.product_variations?.products?.name ?? '—'}
                    </p>
                    {variation && (
                      <p className="text-sm text-text-muted">{variation}</p>
                    )}
                    <p className="text-xs text-text-muted font-mono mt-0.5">
                      {item.product_variations?.sku_variation}
                    </p>

                    {/* Info de qtd */}
                    <div className="flex flex-wrap gap-3 mt-2 text-xs text-text-muted">
                      <span>
                        Qtd original:{' '}
                        <span className="text-text-secondary font-medium">{item.quantity}</span>
                      </span>
                      {item.already_returned > 0 && (
                        <span className="text-warning">
                          Já devolvido: {item.already_returned}
                        </span>
                      )}
                      <span>
                        Disponível p/ troca:{' '}
                        <span className="text-text-secondary font-medium">{item.available_to_return}</span>
                      </span>
                      <span>
                        {formatCurrency(item.unit_price)}/un
                      </span>
                    </div>
                  </div>

                  {/* Seletor de quantidade */}
                  <div className="flex-shrink-0 flex flex-col items-end gap-2">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setQty(item.id, qty - 1, item.available_to_return)}
                        disabled={qty === 0}
                        className="w-7 h-7 rounded border border-border bg-bg-subtle flex items-center justify-center text-text-secondary hover:bg-bg-hover disabled:opacity-30 transition-colors text-lg leading-none"
                      >
                        −
                      </button>
                      <span className="w-8 text-center font-mono font-medium text-text-primary">
                        {qty}
                      </span>
                      <button
                        type="button"
                        onClick={() => setQty(item.id, qty + 1, item.available_to_return)}
                        disabled={qty >= item.available_to_return}
                        className="w-7 h-7 rounded border border-border bg-bg-subtle flex items-center justify-center text-text-secondary hover:bg-bg-hover disabled:opacity-30 transition-colors text-lg leading-none"
                      >
                        +
                      </button>
                    </div>

                    {lineTotal > 0 && (
                      <span className="text-sm font-semibold text-brand">
                        {formatCurrency(lineTotal)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      {/* Observações */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text-secondary">
          Observações (opcional)
        </label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Ex: peça com defeito, tamanho errado..."
          maxLength={500}
          rows={2}
          className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand/40 resize-none"
        />
      </div>

      {/* Resumo + Confirmar */}
      <Card padding="md">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-text-secondary text-sm">
              <ArrowRightLeft className="w-4 h-4" />
              <span>
                {Object.values(quantities).reduce((a, b) => a + b, 0)} peça
                {Object.values(quantities).reduce((a, b) => a + b, 0) !== 1 ? 's' : ''} para devolver
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between py-3 border-t border-border">
            <span className="text-sm text-text-muted">Crédito gerado para {customerName}</span>
            <span className={`text-2xl font-bold tabular-nums ${totalCredit > 0 ? 'text-success' : 'text-text-muted'}`}>
              {formatCurrency(totalCredit)}
            </span>
          </div>

          {totalCredit > 0 && (
            <p className="text-xs text-text-muted">
              O crédito fica disponível imediatamente na conta da cliente e pode ser usado em qualquer compra futura.
            </p>
          )}

          <Button
            className="w-full"
            onClick={handleSubmit}
            disabled={!hasSelection || loading}
            loading={loading}
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Confirmar Troca e Gerar Crédito de {formatCurrency(totalCredit)}
          </Button>
        </div>
      </Card>
    </div>
  )
}
