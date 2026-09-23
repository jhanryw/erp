'use client'

import { useEffect, useState } from 'react'
import { Loader2, Plus, Search, Trash2 } from 'lucide-react'
import { useDebounce } from '@/hooks/useDebounce'
import { formatCurrency } from '@/lib/utils/currency'
import {
  componentKitCapacity,
  computeKitAvailability,
  computeKitUnitCost,
} from '@/lib/inventory/stockRequirements'
import type { KitComponentSearchItem } from '@/app/api/produtos/kits/componentes/buscar/route'

/** Linha de composição em edição (dados de exibição + quantidade por kit). */
export interface KitComponentDraft {
  component_product_variation_id: number
  quantity: number
  product_name: string
  sku_variation: string
  cor: string | null
  tamanho: string | null
  unit_cost: number
  available_main_store: number
  available_online: number
}

interface Props {
  value: KitComponentDraft[]
  onChange?: (next: KitComponentDraft[]) => void
  readOnly?: boolean
}

/** O editor vive dentro de formulários — Enter num campo dele nunca deve submeter o form pai. */
function preventEnterSubmit(e: React.KeyboardEvent<HTMLInputElement>) {
  if (e.key === 'Enter') e.preventDefault()
}

export const KIT_NO_OWN_STOCK_NOTICE =
  'Este produto não possui estoque próprio. A disponibilidade é calculada automaticamente pelos componentes.'

/**
 * Editor de composição de UMA variação de kit. Toda a matemática exibida
 * (capacidade por componente, disponibilidade do kit, custo) vem das mesmas
 * funções puras usadas pelo servidor (src/lib/inventory/stockRequirements.ts)
 * — a tela nunca reimplementa a fórmula. O servidor recalcula tudo ao salvar.
 */
export function KitComponentsEditor({ value, onChange, readOnly = false }: Props) {
  const editable = !readOnly && !!onChange

  const availableOnline = computeKitAvailability(value.map((c) => ({ quantity: c.quantity, available: c.available_online })))
  const availableMain = computeKitAvailability(value.map((c) => ({ quantity: c.quantity, available: c.available_main_store })))
  const unitCost = computeKitUnitCost(value)

  function update(id: number, patch: Partial<KitComponentDraft>) {
    onChange?.(value.map((c) => (c.component_product_variation_id === id ? { ...c, ...patch } : c)))
  }

  function remove(id: number) {
    onChange?.(value.filter((c) => c.component_product_variation_id !== id))
  }

  function add(item: KitComponentSearchItem) {
    // Mesmo componente adicionado de novo → soma a quantidade (consolidação
    // determinística, igual ao servidor).
    const existing = value.find((c) => c.component_product_variation_id === item.product_variation_id)
    if (existing) {
      update(existing.component_product_variation_id, { quantity: existing.quantity + 1 })
      return
    }
    onChange?.([...value, {
      component_product_variation_id: item.product_variation_id,
      quantity: 1,
      product_name: item.product_name,
      sku_variation: item.sku_variation,
      cor: item.cor,
      tamanho: item.tamanho,
      unit_cost: item.unit_cost,
      available_main_store: item.available_main_store,
      available_online: item.available_online,
    }])
  }

  return (
    <div className="space-y-3">
      <p className="rounded-lg border border-brand/20 bg-brand/5 px-3 py-2 text-xs text-text-secondary">
        {KIT_NO_OWN_STOCK_NOTICE}
      </p>

      {value.length === 0 ? (
        <p className="text-sm text-text-muted">Nenhum componente. Um kit precisa de pelo menos um.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {value.map((c) => {
            const capacity = componentKitCapacity(c.available_online, c.quantity)
            const isBottleneck = value.length > 1 && capacity === availableOnline
            return (
              <li key={c.component_product_variation_id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text-primary">{c.product_name}</p>
                  <p className="text-xs text-text-muted">
                    {[c.cor, c.tamanho].filter(Boolean).join(' / ')}
                    {(c.cor || c.tamanho) && ' · '}
                    <code className="font-mono">SKU {c.sku_variation}</code>
                  </p>
                </div>

                <div className="w-28">
                  {editable ? (
                    <label className="block text-[11px] text-text-muted">
                      Qtd. por kit
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={c.quantity}
                        onChange={(e) => update(c.component_product_variation_id, { quantity: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
                        onKeyDown={preventEnterSubmit}
                        className="input-base mt-0.5 h-8 text-sm"
                        aria-label={`Quantidade de ${c.sku_variation} por kit`}
                      />
                    </label>
                  ) : (
                    <p className="text-sm"><span className="text-[11px] text-text-muted">Qtd. por kit</span><br />{c.quantity}</p>
                  )}
                </div>

                <div className="w-32 text-sm">
                  <span className="text-[11px] text-text-muted">Estoque disponível</span>
                  <p className="tabular-nums">
                    {c.available_online}
                    <span className="ml-1 text-[11px] text-text-muted">(loja {c.available_main_store})</span>
                  </p>
                </div>

                <div className="w-24 text-sm">
                  <span className="text-[11px] text-text-muted">Permite</span>
                  <p className={`tabular-nums font-medium ${capacity === 0 ? 'text-error' : isBottleneck ? 'text-warning' : ''}`}>
                    {capacity} kit{capacity === 1 ? '' : 's'}
                  </p>
                </div>

                {editable && (
                  <button
                    type="button"
                    onClick={() => remove(c.component_product_variation_id)}
                    className="rounded-lg p-2 text-text-muted hover:bg-error/10 hover:text-error"
                    aria-label={`Remover ${c.sku_variation}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {editable && <ComponentSearch onPick={add} />}

      <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-bg-overlay px-3 py-2.5">
        <p className="text-sm font-semibold text-text-primary">
          Disponibilidade do kit: <span className={`tabular-nums ${availableOnline === 0 ? 'text-error' : ''}`}>{availableOnline} unidade{availableOnline === 1 ? '' : 's'}</span>
          <span className="ml-2 text-xs font-normal text-text-muted">(Estoque Loja/PDV: {availableMain})</span>
        </p>
        <p className="text-xs text-text-muted">Custo derivado: <span className="font-medium text-text-primary">{formatCurrency(unitCost)}</span></p>
      </div>
    </div>
  )
}

function ComponentSearch({ onPick }: { onPick: (item: KitComponentSearchItem) => void }) {
  const [q, setQ] = useState('')
  const debounced = useDebounce(q, 300)
  const [items, setItems] = useState<KitComponentSearchItem[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (debounced.trim().length < 2) {
      setItems([])
      return
    }
    let cancelled = false
    setLoading(true)
    fetch(`/api/produtos/kits/componentes/buscar?q=${encodeURIComponent(debounced.trim())}`)
      .then((r) => r.json())
      .then((json) => { if (!cancelled) setItems(json.items ?? []) })
      .catch(() => { if (!cancelled) setItems([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [debounced])

  return (
    <div className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={preventEnterSubmit}
          placeholder="Buscar produto ou SKU para adicionar ao kit…"
          className="input-base pl-9"
          aria-label="Buscar componente"
        />
        {loading && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-text-muted" />}
      </div>
      {items.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-border bg-bg-card shadow-lg">
          {items.map((item) => (
            <li key={item.product_variation_id}>
              <button
                type="button"
                onClick={() => { onPick(item); setQ(''); setItems([]) }}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-bg-overlay"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{item.product_name}</span>
                  <span className="block text-xs text-text-muted">
                    {[item.cor, item.tamanho].filter(Boolean).join(' / ')}{(item.cor || item.tamanho) && ' · '}
                    <code className="font-mono">{item.sku_variation}</code>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-text-muted">
                  {item.available_online} em estoque
                  <Plus className="h-4 w-4 text-brand" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
