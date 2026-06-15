'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  ArrowRight,
  Search,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'

// ─── Types ────────────────────────────────────────────────────────────────────

export type LocationForSelect = {
  id:           number
  name:         string
  is_main_store: boolean
}

export type BalanceAtLocation = {
  location_id:   number
  quantity:      number
  location_name: string
}

export type StockItemForTransfer = {
  product_variation_id: number
  product_name:         string
  sku_variation:        string
  sku_parent:           string | null
  cor:                  string | null
  tamanho:              string | null
  balances_by_location: BalanceAtLocation[]
}

type TransferredItem = {
  product_variation_id: number
  product_name:         string | null
  sku_variation:        string | null
  quantity:             number
  from_qty_before:      number
  from_qty_after:       number
  to_qty_before:        number
  to_qty_after:         number
}

type BizError = {
  product_variation_id: number | null
  product_name:         string | null
  sku_variation:        string | null
  quantity_requested:   number | null
  balance_available:    number | null
  reason:               string
  suggestion:           string
}

type ApiResult =
  | {
      type: 'success'
      batch_id:         string
      from_location_id: number
      to_location_id:   number
      total_items:      number
      total_quantity:   number
      transferred:      TransferredItem[]
    }
  | { type: 'biz_error'; errors: BizError[] }
  | { type: 'error'; message: string }

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  locations:  LocationForSelect[]
  stockItems: StockItemForTransfer[]
}

export function BulkTransferForm({ locations, stockItems }: Props) {
  const [fromId, setFromId]     = useState<number | null>(null)
  const [toId, setToId]         = useState<number | null>(null)
  const [notes, setNotes]       = useState('')
  const [search, setSearch]     = useState('')
  const [checkedIds, setCheckedIds]   = useState<Set<number>>(new Set())
  const [quantities, setQuantities]   = useState<Record<number, string>>({})
  const [submitting, setSubmitting]   = useState(false)
  const [apiResult, setApiResult]     = useState<ApiResult | null>(null)

  function handleFromChange(id: number | null) {
    setFromId(id)
    setCheckedIds(new Set())
    setQuantities({})
    setSearch('')
    setApiResult(null)
  }

  function handleToChange(id: number | null) {
    setToId(id)
    setApiResult(null)
  }

  const filteredItems = useMemo(() => {
    if (!fromId) return []
    return stockItems
      .filter(item =>
        item.balances_by_location.some(b => b.location_id === fromId && b.quantity > 0)
      )
      .filter(item => {
        const q = search.trim().toLowerCase()
        if (!q) return true
        return (
          item.product_name.toLowerCase().includes(q) ||
          item.sku_variation.toLowerCase().includes(q) ||
          (item.sku_parent?.toLowerCase().includes(q) ?? false)
        )
      })
  }, [stockItems, fromId, search])

  function getAvailableQty(pvid: number): number {
    if (!fromId) return 0
    const item = stockItems.find(i => i.product_variation_id === pvid)
    return item?.balances_by_location.find(b => b.location_id === fromId)?.quantity ?? 0
  }

  function toggleItem(pvid: number) {
    setCheckedIds(prev => {
      const next = new Set(prev)
      if (next.has(pvid)) {
        next.delete(pvid)
      } else {
        next.add(pvid)
        setQuantities(q => ({ ...q, [pvid]: '1' }))
      }
      return next
    })
  }

  function selectAllFiltered() {
    setCheckedIds(prev => {
      const next = new Set(prev)
      filteredItems.forEach(i => next.add(i.product_variation_id))
      return next
    })
    setQuantities(q => {
      const next = { ...q }
      filteredItems.forEach(i => {
        if (!next[i.product_variation_id]) next[i.product_variation_id] = '1'
      })
      return next
    })
  }

  function clearAllFiltered() {
    const toRemove = new Set(filteredItems.map(i => i.product_variation_id))
    setCheckedIds(prev => {
      const next = new Set(prev)
      toRemove.forEach(pvid => next.delete(pvid))
      return next
    })
  }

  const hasAnyQtyError = useMemo(() => {
    for (const pvid of checkedIds) {
      const raw = quantities[pvid] ?? ''
      const n = parseInt(raw, 10)
      if (!raw || isNaN(n) || n <= 0) return true
      const item = stockItems.find(i => i.product_variation_id === pvid)
      const avail = item?.balances_by_location.find(b => b.location_id === fromId)?.quantity ?? 0
      if (n > avail) return true
    }
    return false
  }, [checkedIds, quantities, stockItems, fromId])

  const totalUnits = useMemo(
    () =>
      Array.from(checkedIds).reduce((acc, pvid) => {
        const n = parseInt(quantities[pvid] ?? '0', 10)
        return acc + (isNaN(n) ? 0 : n)
      }, 0),
    [checkedIds, quantities],
  )

  const canSubmit =
    !submitting &&
    !!fromId &&
    !!toId &&
    fromId !== toId &&
    checkedIds.size > 0 &&
    !hasAnyQtyError

  async function handleSubmit() {
    if (!canSubmit || !fromId || !toId) return
    setSubmitting(true)
    setApiResult(null)

    const items = Array.from(checkedIds).map(pvid => ({
      product_variation_id: pvid,
      quantity: parseInt(quantities[pvid] ?? '1', 10),
    }))

    try {
      const res = await fetch('/api/estoque/transferencia/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_location_id: fromId,
          to_location_id:   toId,
          notes:            notes.trim() || null,
          items,
        }),
      })
      const data = await res.json()

      if (res.ok) {
        setApiResult({ type: 'success', ...data })
        setCheckedIds(new Set())
        setQuantities({})
        setNotes('')
      } else if (data.ok === false) {
        setApiResult({ type: 'biz_error', errors: data.errors })
      } else {
        setApiResult({ type: 'error', message: data.error ?? 'Erro ao processar transferência.' })
      }
    } catch {
      setApiResult({ type: 'error', message: 'Erro de rede. Tente novamente.' })
    } finally {
      setSubmitting(false)
    }
  }

  const fromLocation = locations.find(l => l.id === fromId)
  const toLocation   = locations.find(l => l.id === toId)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/estoque">
          <Button variant="ghost" size="icon" aria-label="Voltar para Estoque">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Transferência em Massa</h1>
          <p className="text-sm text-muted-foreground">
            Mova vários produtos entre locais em uma única operação
          </p>
        </div>
      </div>

      {/* Disclaimer */}
      <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/8 px-4 py-3">
        <AlertCircle className="h-5 w-5 text-warning mt-0.5 shrink-0" />
        <p className="text-sm text-warning">
          Esta operação é irreversível. Verifique os locais e quantidades antes de confirmar.
        </p>
      </div>

      {/* Section 1: Configuração */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold">Configuração</h2>

        <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3">
          <div className="flex-1 min-w-0">
            <label className="block text-xs text-muted-foreground mb-1.5">Origem</label>
            <select
              value={fromId ?? ''}
              onChange={e => handleFromChange(e.target.value ? Number(e.target.value) : null)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Selecionar local</option>
              {locations.map(l => (
                <option key={l.id} value={l.id} disabled={l.id === toId}>
                  {l.name}{l.is_main_store ? ' (Principal)' : ''}
                </option>
              ))}
            </select>
          </div>

          <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0 mb-2.5 hidden sm:block" />

          <div className="flex-1 min-w-0">
            <label className="block text-xs text-muted-foreground mb-1.5">Destino</label>
            <select
              value={toId ?? ''}
              onChange={e => handleToChange(e.target.value ? Number(e.target.value) : null)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Selecionar local</option>
              {locations.map(l => (
                <option key={l.id} value={l.id} disabled={l.id === fromId}>
                  {l.name}{l.is_main_store ? ' (Principal)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        {fromId && toId && fromId === toId && (
          <p className="text-xs text-destructive">Origem e destino não podem ser iguais.</p>
        )}

        <div>
          <label className="block text-xs text-muted-foreground mb-1.5">
            Observação <span className="text-muted-foreground/60">(opcional)</span>
          </label>
          <textarea
            rows={2}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Ex: Transferência para temporada de verão"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {/* Section 2: Selecionar Produtos */}
      {fromId && toId && fromId !== toId && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          {/* Subheader */}
          <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold">
              Produtos em{' '}
              <span className="text-foreground">{fromLocation?.name ?? ''}</span>
            </h2>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={selectAllFiltered}
                className="text-xs text-primary hover:underline"
              >
                Selecionar todos
              </button>
              <span className="text-xs text-muted-foreground">·</span>
              <button
                type="button"
                onClick={clearAllFiltered}
                className="text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                Limpar
              </button>
            </div>
          </div>

          {/* Search */}
          <div className="px-5 py-3 border-b border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <input
                type="search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Buscar por produto ou SKU…"
                className="w-full rounded-lg border border-border bg-background pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
              />
            </div>
          </div>

          {/* Product list */}
          {filteredItems.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <p className="text-sm text-muted-foreground">
                {search
                  ? 'Nenhum produto encontrado para esta busca.'
                  : 'Nenhum produto com saldo neste local.'}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border max-h-[480px] overflow-y-auto">
              {filteredItems.map(item => {
                const pvid    = item.product_variation_id
                const avail   = getAvailableQty(pvid)
                const checked = checkedIds.has(pvid)
                const rawQty  = quantities[pvid] ?? ''
                const n       = parseInt(rawQty, 10)
                const qtyErr  = checked
                  ? (!rawQty || isNaN(n) || n <= 0
                    ? 'Mínimo 1'
                    : n > avail
                    ? `Máx ${avail}`
                    : null)
                  : null
                const subtitle = [item.sku_variation, item.cor, item.tamanho]
                  .filter(Boolean)
                  .join(' · ')

                return (
                  <div
                    key={pvid}
                    className={`flex items-center gap-3 px-5 py-3 transition-colors ${
                      checked ? 'bg-primary/5' : 'hover:bg-muted/30'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleItem(pvid)}
                      className="h-4 w-4 rounded accent-primary shrink-0 cursor-pointer"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{item.product_name}</p>
                      {subtitle && (
                        <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                      Saldo:{' '}
                      <span className="font-medium text-foreground">{avail}</span>
                    </div>
                    {checked && (
                      <div className="shrink-0 text-right">
                        <input
                          type="number"
                          min={1}
                          max={avail}
                          value={rawQty}
                          onChange={e => setQuantities(q => ({ ...q, [pvid]: e.target.value }))}
                          className={`w-20 rounded-md border px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-ring bg-background ${
                            qtyErr
                              ? 'border-destructive text-destructive'
                              : 'border-border'
                          }`}
                        />
                        {qtyErr && (
                          <p className="text-xs text-destructive mt-0.5">{qtyErr}</p>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Summary + submit */}
          <div className="flex items-center justify-between gap-4 px-5 py-4 border-t border-border bg-muted/20">
            <p className="text-sm text-muted-foreground">
              {checkedIds.size > 0 ? (
                <>
                  <span className="font-semibold text-foreground">{checkedIds.size}</span>{' '}
                  {checkedIds.size === 1 ? 'item' : 'itens'} ·{' '}
                  <span className="font-semibold text-foreground">{totalUnits}</span>{' '}
                  {totalUnits === 1 ? 'unidade' : 'unidades'}
                </>
              ) : (
                'Nenhum item selecionado'
              )}
            </p>
            <Button onClick={handleSubmit} disabled={!canSubmit} className="shrink-0">
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Transferindo…
                </>
              ) : (
                `Transferir${checkedIds.size > 0 ? ` (${checkedIds.size})` : ''}`
              )}
            </Button>
          </div>
        </div>
      )}

      {/* API result */}
      {apiResult && (
        <div>
          {apiResult.type === 'success' && (
            <div className="rounded-xl border border-green-500/30 bg-green-500/8 p-5 space-y-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
                <h3 className="text-sm font-semibold text-green-700 dark:text-green-400">
                  Transferência concluída
                </h3>
              </div>
              <p className="text-sm text-foreground">
                <span className="font-semibold">{apiResult.total_items}</span>{' '}
                {apiResult.total_items === 1 ? 'produto' : 'produtos'} ·{' '}
                <span className="font-semibold">{apiResult.total_quantity}</span>{' '}
                {apiResult.total_quantity === 1 ? 'unidade' : 'unidades'} transferidas de{' '}
                <span className="font-medium">{fromLocation?.name}</span> para{' '}
                <span className="font-medium">{toLocation?.name}</span>
              </p>
              <p className="text-xs text-muted-foreground font-mono">
                Lote: {apiResult.batch_id}
              </p>
              <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
                {apiResult.transferred.map(t => (
                  <div
                    key={t.product_variation_id}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                  >
                    <span className="font-medium truncate">
                      {t.product_name ?? `pvid:${t.product_variation_id}`}
                    </span>
                    <span className="text-muted-foreground shrink-0">
                      {t.sku_variation}
                    </span>
                    <span className="text-muted-foreground shrink-0 font-mono">
                      ×{t.quantity} · {t.from_qty_before}→{t.from_qty_after} /{' '}
                      {t.to_qty_before}→{t.to_qty_after}
                    </span>
                  </div>
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setApiResult(null)
                  setFromId(null)
                  setToId(null)
                  setNotes('')
                  setSearch('')
                }}
              >
                Nova transferência
              </Button>
            </div>
          )}

          {apiResult.type === 'biz_error' && (
            <div className="rounded-xl border border-destructive/40 bg-destructive/8 p-5 space-y-4">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-sm font-semibold text-destructive">
                    Transferência cancelada —{' '}
                    {apiResult.errors.length}{' '}
                    {apiResult.errors.length === 1 ? 'problema encontrado' : 'problemas encontrados'}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Nenhum item foi transferido. Corrija os problemas abaixo e tente novamente.
                  </p>
                </div>
              </div>
              <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
                {apiResult.errors.map((e, i) => (
                  <div key={i} className="px-3 py-3 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">
                        {e.product_name ?? 'Produto desconhecido'}
                      </span>
                      {e.sku_variation && (
                        <span className="text-xs text-muted-foreground shrink-0">
                          {e.sku_variation}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-destructive">{e.reason}</p>
                    {(e.quantity_requested != null || e.balance_available != null) && (
                      <p className="text-xs text-muted-foreground">
                        Solicitado: {e.quantity_requested ?? '?'} · Disponível:{' '}
                        {e.balance_available ?? '?'}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground italic">{e.suggestion}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {apiResult.type === 'error' && (
            <div className="flex items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/8 px-4 py-3">
              <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
              <p className="text-sm text-destructive">{apiResult.message}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
