'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeftRight } from 'lucide-react'
import { Card, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import { formatNumber, formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

type LocationBalance = {
  location_id: number
  location_name: string
  slug: string
  is_main_store: boolean
  priority: number
  quantity: number
}

type MultiStockRow = {
  product_variation_id: number
  product_id: number
  product_name: string
  sku_variation: string
  sku_parent: string | null
  tamanho: string | null
  cor: string | null
  total_qty: number
  main_store_qty: number
  needs_transfer: boolean
  total_stock_value_at_cost: number | null
  last_entry_date: string | null
  balances_by_location: LocationBalance[]
}

type StockLocation = {
  id: number
  name: string
  slug: string
  is_main_store: boolean
  priority: number
}

interface Props {
  items: MultiStockRow[]
  locations: StockLocation[]
}

interface TransferState {
  open: boolean
  pvid: number | null
  pvName: string
  fromLocationId: number | null
  toLocationId: number | null
  quantity: string
  notes: string
  balances: LocationBalance[]
}

export function EstoqueMultiTable({ items, locations }: Props) {
  const router = useRouter()
  const [transfer, setTransfer] = useState<TransferState>({
    open: false, pvid: null, pvName: '', fromLocationId: null,
    toLocationId: null, quantity: '', notes: '', balances: [],
  })
  const [loading, setLoading] = useState(false)

  function openTransfer(item: MultiStockRow) {
    const mainStore = item.balances_by_location.find((b) => b.is_main_store)
    setTransfer({
      open: true,
      pvid: item.product_variation_id,
      pvName: `${item.product_name} — ${item.sku_variation}`,
      fromLocationId: item.balances_by_location[0]?.location_id ?? null,
      toLocationId:   mainStore?.location_id ?? item.balances_by_location[1]?.location_id ?? null,
      quantity: '',
      notes: '',
      balances: item.balances_by_location,
    })
  }

  function closeTransfer() {
    setTransfer((s) => ({ ...s, open: false }))
  }

  async function handleTransfer() {
    if (!transfer.pvid || !transfer.fromLocationId || !transfer.toLocationId) return
    const qty = parseInt(transfer.quantity)
    if (isNaN(qty) || qty <= 0) {
      toast.error('Quantidade deve ser maior que zero')
      return
    }
    if (transfer.fromLocationId === transfer.toLocationId) {
      toast.error('Origem e destino não podem ser iguais')
      return
    }
    const fromBalance = transfer.balances.find((b) => b.location_id === transfer.fromLocationId)
    if (fromBalance && qty > fromBalance.quantity) {
      toast.error(`Saldo insuficiente em "${fromBalance.location_name}". Disponível: ${fromBalance.quantity}`)
      return
    }

    setLoading(true)
    try {
      const res = await fetch('/api/estoque/transferencia', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_variation_id: transfer.pvid,
          from_location_id:     transfer.fromLocationId,
          to_location_id:       transfer.toLocationId,
          quantity:             qty,
          notes:                transfer.notes || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error('Erro na transferência', { description: typeof json.error === 'string' ? json.error : JSON.stringify(json.error) })
        return
      }
      toast.success(`${qty} unidade(s) transferida(s) com sucesso`)
      closeTransfer()
      router.refresh()
    } catch {
      toast.error('Erro inesperado na transferência')
    } finally {
      setLoading(false)
    }
  }

  // Derivar todas as colunas de localização (ordenadas por priority)
  const locationCols = locations

  return (
    <>
      <Card>
        <CardHeader className="text-sm text-muted-foreground">
          {items.length} variação{items.length !== 1 ? 'ões' : ''} em estoque
          {locationCols.length > 1 && (
            <span className="ml-2 text-xs text-brand">· {locationCols.length} locais</span>
          )}
        </CardHeader>

        {/* ── Mobile: cards ───────────────────────────────────────── */}
        <div className="md:hidden divide-y divide-border">
          {items.map((item) => (
            <div key={item.product_variation_id} className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-text-primary truncate">{item.product_name}</p>
                  <p className="text-xs text-text-muted mt-0.5">
                    <code className="font-mono">{item.sku_variation}</code>
                    {(item.cor || item.tamanho) && (
                      <span className="ml-1.5">{[item.cor, item.tamanho].filter(Boolean).join(' · ')}</span>
                    )}
                  </p>
                  {/* Saldos por local */}
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5">
                    {item.balances_by_location.map((b) => (
                      <span key={b.location_id} className={`text-xs ${b.is_main_store ? 'font-medium text-text-primary' : 'text-text-muted'}`}>
                        {b.location_name}: <span className={b.quantity === 0 ? 'text-error' : b.quantity <= 3 ? 'text-warning' : ''}>{b.quantity}</span>
                      </span>
                    ))}
                  </div>
                  {item.needs_transfer && (
                    <p className="text-xs text-warning mt-1">⚠ Tem estoque fora da Loja — transfira para vender</p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <div className="text-right">
                    <p className={`text-lg font-bold tabular-nums ${item.total_qty === 0 ? 'text-error' : item.total_qty <= 3 ? 'text-warning' : 'text-text-primary'}`}>
                      {formatNumber(item.total_qty)}
                    </p>
                    <p className="text-[10px] text-text-muted leading-none">total</p>
                  </div>
                  {locationCols.length > 1 && (
                    <Button
                      variant="outline"
                      onClick={() => openTransfer(item)}
                      className="h-7 px-2 text-xs"
                    >
                      <ArrowLeftRight className="w-3 h-3 mr-1" />
                      Transferir
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* ── Desktop: tabela ─────────────────────────────────────── */}
        <div className="hidden md:block overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produto</TableHead>
                <TableHead>Cor</TableHead>
                <TableHead>Tamanho</TableHead>
                <TableHead>SKU</TableHead>
                {locationCols.map((loc) => (
                  <TableHead key={loc.id} className={loc.is_main_store ? 'font-semibold' : ''}>
                    {loc.name}
                    {loc.is_main_store && <span className="ml-1 text-xs text-text-muted">(loja)</span>}
                  </TableHead>
                ))}
                {locationCols.length > 1 && <TableHead>Total</TableHead>}
                <TableHead>Custo Médio</TableHead>
                <TableHead>Última Entrada</TableHead>
                {locationCols.length > 1 && <TableHead></TableHead>}
              </TableRow>
            </TableHeader>

            <TableBody>
              {items.map((item) => {
                const balanceMap = new Map(item.balances_by_location.map((b) => [b.location_id, b.quantity]))

                return (
                  <TableRow key={item.product_variation_id} className={item.needs_transfer ? 'bg-warning/5' : ''}>
                    <TableCell className="font-medium">
                      {item.product_name}
                      {item.needs_transfer && (
                        <span className="ml-2 text-[10px] font-normal text-warning">⚠ transfira</span>
                      )}
                    </TableCell>
                    <TableCell>{item.cor ?? '—'}</TableCell>
                    <TableCell>{item.tamanho ?? '—'}</TableCell>
                    <TableCell><code>{item.sku_variation}</code></TableCell>

                    {locationCols.map((loc) => {
                      const qty = balanceMap.get(loc.id) ?? 0
                      return (
                        <TableCell key={loc.id} className={`tabular-nums ${qty === 0 ? 'text-text-muted' : qty <= 3 ? 'text-warning font-medium' : ''}`}>
                          {formatNumber(qty)}
                        </TableCell>
                      )
                    })}

                    {locationCols.length > 1 && (
                      <TableCell className={`tabular-nums font-semibold ${item.total_qty === 0 ? 'text-error' : item.total_qty <= 3 ? 'text-warning' : ''}`}>
                        {formatNumber(item.total_qty)}
                      </TableCell>
                    )}

                    <TableCell>
                      {/* avg_cost não vem da vw_stock_live_multi; mostrar custo do Estoque Loja */}
                      —
                    </TableCell>
                    <TableCell>
                      {item.last_entry_date ? formatDate(item.last_entry_date) : '—'}
                    </TableCell>

                    {locationCols.length > 1 && (
                      <TableCell>
                        <Button
                          variant="outline"
                          onClick={() => openTransfer(item)}
                          className="h-7 px-2 text-xs"
                        >
                          <ArrowLeftRight className="w-3 h-3 mr-1" />
                          Transferir
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* ── Modal de transferência ─────────────────────────────────── */}
      {transfer.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="card w-full max-w-md p-6 space-y-4 bg-bg-card">
            <h2 className="text-lg font-semibold">Transferir Estoque</h2>
            <p className="text-sm text-text-muted truncate">{transfer.pvName}</p>

            <Select
              label="De (origem)"
              value={transfer.fromLocationId?.toString() ?? ''}
              onChange={(e) => setTransfer((s) => ({ ...s, fromLocationId: parseInt(e.target.value) }))}
            >
              {transfer.balances
                .filter((b) => b.quantity > 0)
                .map((b) => (
                  <option key={b.location_id} value={b.location_id}>
                    {b.location_name} — {b.quantity} un.
                  </option>
                ))}
            </Select>

            <Select
              label="Para (destino)"
              value={transfer.toLocationId?.toString() ?? ''}
              onChange={(e) => setTransfer((s) => ({ ...s, toLocationId: parseInt(e.target.value) }))}
            >
              {locations
                .filter((l) => l.id !== transfer.fromLocationId)
                .map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
            </Select>

            <Input
              label="Quantidade"
              type="number"
              min={1}
              max={transfer.balances.find((b) => b.location_id === transfer.fromLocationId)?.quantity ?? 9999}
              value={transfer.quantity}
              onChange={(e) => setTransfer((s) => ({ ...s, quantity: e.target.value }))}
              placeholder="Ex: 5"
            />

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-text-secondary">Observação (opcional)</label>
              <textarea
                value={transfer.notes}
                onChange={(e) => setTransfer((s) => ({ ...s, notes: e.target.value }))}
                rows={2}
                maxLength={500}
                className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand/40 resize-none"
              />
            </div>

            <div className="flex gap-3 pt-1">
              <Button
                variant="secondary"
                className="flex-1 h-11"
                onClick={closeTransfer}
                disabled={loading}
              >
                Cancelar
              </Button>
              <Button
                className="flex-1 h-11"
                loading={loading}
                onClick={handleTransfer}
                disabled={!transfer.quantity || transfer.fromLocationId === transfer.toLocationId}
              >
                <ArrowLeftRight className="w-4 h-4" />
                Transferir
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
