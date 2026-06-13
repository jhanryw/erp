'use client'

import { useEffect, useState, useMemo } from 'react'
import { Loader2, Truck, CheckCircle2, Clock, AlertCircle, RefreshCw, Layers } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'

// ─── Types ──────────────────────────────────────────────────────────────────────

type RepasseStatus = 'pending' | 'paid' | 'not_applicable'

interface RepasseItem {
  id: number
  order_id?: number
  status: string
  motoboy?: string
  courier_phone?: string
  internal_cost?: number
  internal_cost_real?: number
  repasse_status: RepasseStatus
  repasse_amount?: number
  repasse_paid_at?: string
  repasse_batch_id?: number
  repasse_finance_entry_id?: number
  created_at: string
  sales?: { sale_number?: string; shipping_charged?: number }
  customers?: { name?: string }
  customer_addresses?: { neighborhood?: string; city?: string }
  shipping_zones?: { name?: string; color?: string }
  shipping_rules?: { client_price?: number; internal_cost?: number }
}

interface NeedsConfirmationPayload {
  shipments_without_motoboy: number[]
  count_without_motoboy: number
  message: string
}

interface BatchResult {
  batch_id: number
  total_amount: number
  shipment_count: number
  entries: { shipment_id: number; finance_entry_id: number; amount: number; sale_number?: string; motoboy?: string }[]
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function effectiveRepasse(item: RepasseItem): number | null {
  const v = item.internal_cost_real ?? item.repasse_amount ?? item.internal_cost ?? item.shipping_rules?.internal_cost
  return v != null ? Number(v) : null
}

function isValidRepasse(item: RepasseItem): boolean {
  return (effectiveRepasse(item) ?? 0) > 0
}

function formatCurrency(value: number | null | undefined): string {
  if (value == null) return '—'
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value)
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

function adminFee(item: RepasseItem): number | null {
  const charged = item.sales?.shipping_charged
  const repasse = effectiveRepasse(item)
  if (charged == null || repasse == null) return null
  return Number(charged) - repasse
}

// ─── Confirm Dialog ──────────────────────────────────────────────────────────────

interface ConfirmDialogProps {
  payload: NeedsConfirmationPayload
  onConfirm: () => void
  onCancel: () => void
}

function ConfirmDialog({ payload, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 space-y-4">
        <div className="flex items-start gap-3">
          <AlertCircle className="text-yellow-500 mt-0.5 shrink-0" size={20} />
          <div>
            <p className="font-semibold text-sm">Motoboy não informado</p>
            <p className="text-sm text-muted-foreground mt-1">{payload.message}</p>
            <p className="text-xs text-muted-foreground mt-2">
              IDs: {payload.shipments_without_motoboy.join(', ')}
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancelar</Button>
          <Button size="sm" onClick={onConfirm}>Prosseguir mesmo assim</Button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────────────────

export default function RepassesPage() {
  const [items, setItems] = useState<RepasseItem[]>([])
  const [loading, setLoading] = useState(true)
  const [closing, setClosing] = useState(false)
  const [payingId, setPayingId] = useState<number | null>(null)
  const [confirmPayload, setConfirmPayload] = useState<NeedsConfirmationPayload | null>(null)

  // Filters
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [filterMotoboy, setFilterMotoboy] = useState('')
  const [filterStatus, setFilterStatus] = useState<'todos' | 'pending' | 'paid'>('todos')
  const [onlyValid, setOnlyValid] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await fetch('/api/shipping/repasse')
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Erro ao carregar repasses')
      setItems(json.shipments ?? [])
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // ─── Derived data ──────────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return items.filter(item => {
      if (filterStatus !== 'todos' && item.repasse_status !== filterStatus) return false
      if (onlyValid && !isValidRepasse(item)) return false
      if (filterMotoboy && !(item.motoboy ?? '').toLowerCase().includes(filterMotoboy.toLowerCase())) return false
      if (dateFrom) {
        const d = new Date(item.created_at)
        if (d < new Date(dateFrom + 'T00:00:00')) return false
      }
      if (dateTo) {
        const d = new Date(item.created_at)
        if (d > new Date(dateTo + 'T23:59:59')) return false
      }
      return true
    })
  }, [items, filterStatus, onlyValid, filterMotoboy, dateFrom, dateTo])

  const pending = useMemo(() => filtered.filter(i => i.repasse_status === 'pending'), [filtered])
  const paid    = useMemo(() => filtered.filter(i => i.repasse_status === 'paid'),    [filtered])

  const pendingValidTotal = useMemo(
    () => pending.filter(isValidRepasse).reduce((acc, i) => acc + (effectiveRepasse(i) ?? 0), 0),
    [pending]
  )
  const paidPeriodTotal = useMemo(
    () => paid.reduce((acc, i) => acc + (effectiveRepasse(i) ?? 0), 0),
    [paid]
  )
  const adminFeeTotal = useMemo(
    () => paid.reduce((acc, i) => {
      const fee = adminFee(i)
      return fee != null ? acc + fee : acc
    }, 0),
    [paid]
  )

  // ─── Individual repasse ─────────────────────────────────────────────────────────

  async function handlePayIndividual(item: RepasseItem) {
    const amt = effectiveRepasse(item)
    const label = item.sales?.sale_number ?? `#${item.id}`
    if (!window.confirm(`Pagar repasse da entrega ${label}?\nValor: ${formatCurrency(amt)}`)) return

    setPayingId(item.id)
    try {
      const res = await fetch(`/api/shipping/shipments/${item.id}/repasse/pagar`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Erro ao pagar repasse')
      setItems(prev => prev.map(i =>
        i.id === item.id
          ? { ...i, repasse_status: 'paid', repasse_paid_at: json.repasse?.repasse_paid_at, repasse_finance_entry_id: json.repasse?.finance_entry_id }
          : i
      ))
      toast.success(`Repasse pago: ${formatCurrency(json.repasse?.repasse_amount)}`)
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setPayingId(null)
    }
  }

  // ─── Batch repasse ──────────────────────────────────────────────────────────────

  async function handleFecharRepasse(forceNoMotoboy = false) {
    const validPending = pending.filter(isValidRepasse)
    if (validPending.length === 0) {
      toast.error('Nenhuma entrega pendente com valor de repasse válido.')
      return
    }

    setClosing(true)
    try {
      const res = await fetch('/api/shipping/repasse/fechar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shipment_ids:     validPending.map(i => i.id),
          force_no_motoboy: forceNoMotoboy,
        }),
      })
      const json = await res.json()

      if (res.status === 409 && json.needs_confirmation) {
        setConfirmPayload(json as NeedsConfirmationPayload)
        return
      }

      if (!res.ok) throw new Error(json.error ?? 'Erro ao fechar repasse')

      const batch = json.batch as BatchResult
      const paidIds = new Set(batch.entries.map(e => e.shipment_id))

      setItems(prev => prev.map(i => {
        if (!paidIds.has(i.id)) return i
        const entry = batch.entries.find(e => e.shipment_id === i.id)
        return {
          ...i,
          repasse_status:           'paid' as RepasseStatus,
          repasse_paid_at:          new Date().toISOString(),
          repasse_batch_id:         batch.batch_id,
          repasse_finance_entry_id: entry?.finance_entry_id,
          repasse_amount:           entry?.amount,
        }
      }))

      toast.success(`Lote #${batch.batch_id} fechado — ${batch.shipment_count} entregas — ${formatCurrency(batch.total_amount)}`)
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setClosing(false)
      setConfirmPayload(null)
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground gap-2">
        <Loader2 className="animate-spin" size={18} /> Carregando repasses…
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Repasses ao Motoboy</h1>
          <p className="text-sm text-muted-foreground">Gerencie os valores a pagar e o histórico de fechamentos</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw size={14} className="mr-1" /> Atualizar
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">De</label>
          <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-36 h-8 text-sm" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Até</label>
          <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-36 h-8 text-sm" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Motoboy</label>
          <Input
            placeholder="Filtrar motoboy…"
            value={filterMotoboy}
            onChange={e => setFilterMotoboy(e.target.value)}
            className="w-44 h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Status</label>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value as any)}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="todos">Todos</option>
            <option value="pending">Pendente</option>
            <option value="paid">Pago</option>
          </select>
        </div>
        <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none mb-0.5">
          <input
            type="checkbox"
            checked={onlyValid}
            onChange={e => setOnlyValid(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Somente com valor válido
        </label>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-lg border p-4 space-y-1">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Clock size={12} /> Total pendente
          </p>
          <p className="text-lg font-semibold text-yellow-600">{formatCurrency(pendingValidTotal)}</p>
          <p className="text-xs text-muted-foreground">{pending.filter(isValidRepasse).length} entregas</p>
        </div>
        <div className="rounded-lg border p-4 space-y-1">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Truck size={12} /> Qtd. entregas (período)
          </p>
          <p className="text-lg font-semibold">{filtered.length}</p>
          <p className="text-xs text-muted-foreground">{pending.length} pendentes · {paid.length} pagas</p>
        </div>
        <div className="rounded-lg border p-4 space-y-1">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Layers size={12} /> Taxa admin (pagas)
          </p>
          <p className="text-lg font-semibold text-green-600">{formatCurrency(adminFeeTotal)}</p>
          <p className="text-xs text-muted-foreground">Frete cobrado − repasse</p>
        </div>
        <div className="rounded-lg border p-4 space-y-1">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <CheckCircle2 size={12} /> Total pago (período)
          </p>
          <p className="text-lg font-semibold">{formatCurrency(paidPeriodTotal)}</p>
          <p className="text-xs text-muted-foreground">{paid.length} fechamentos</p>
        </div>
      </div>

      {/* ── Pending table ─────────────────────────────────────────────────────── */}
      {(filterStatus === 'todos' || filterStatus === 'pending') && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-medium text-sm">Pendentes</h2>
            <Button
              size="sm"
              disabled={closing || pending.filter(isValidRepasse).length === 0}
              onClick={() => handleFecharRepasse(false)}
            >
              {closing && <Loader2 size={14} className="mr-1 animate-spin" />}
              Fechar repasse do período ({pending.filter(isValidRepasse).length})
            </Button>
          </div>

          {pending.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Nenhuma entrega pendente no período.</p>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Venda</TableHead>
                    <TableHead className="text-xs">Data</TableHead>
                    <TableHead className="text-xs">Cliente</TableHead>
                    <TableHead className="text-xs">Bairro</TableHead>
                    <TableHead className="text-xs">Motoboy</TableHead>
                    <TableHead className="text-xs text-right">Fr. cobrado</TableHead>
                    <TableHead className="text-xs text-right">Vlr motoboy</TableHead>
                    <TableHead className="text-xs text-right">Taxa loja</TableHead>
                    <TableHead className="text-xs"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pending.map(item => {
                    const repasse = effectiveRepasse(item)
                    const fee     = adminFee(item)
                    const valid   = isValidRepasse(item)
                    return (
                      <TableRow key={item.id} className={!valid ? 'opacity-50' : ''}>
                        <TableCell className="text-xs font-medium">
                          {item.sales?.sale_number ?? `#${item.id}`}
                        </TableCell>
                        <TableCell className="text-xs">{formatDate(item.created_at)}</TableCell>
                        <TableCell className="text-xs">{item.customers?.name ?? '—'}</TableCell>
                        <TableCell className="text-xs">{item.customer_addresses?.neighborhood ?? '—'}</TableCell>
                        <TableCell className="text-xs">
                          {item.motoboy
                            ? <span>{item.motoboy}</span>
                            : <span className="text-yellow-500 text-xs">Sem motoboy</span>
                          }
                        </TableCell>
                        <TableCell className="text-xs text-right">{formatCurrency(item.sales?.shipping_charged)}</TableCell>
                        <TableCell className="text-xs text-right">
                          {valid
                            ? <span className="text-yellow-600 font-medium">{formatCurrency(repasse)}</span>
                            : <span className="text-muted-foreground">—</span>
                          }
                        </TableCell>
                        <TableCell className="text-xs text-right text-muted-foreground">
                          {fee != null ? formatCurrency(fee) : '—'}
                        </TableCell>
                        <TableCell>
                          {valid && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs px-2"
                              disabled={payingId === item.id}
                              onClick={() => handlePayIndividual(item)}
                            >
                              {payingId === item.id
                                ? <Loader2 size={12} className="animate-spin" />
                                : 'Pagar'
                              }
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      )}

      {/* ── Paid history ──────────────────────────────────────────────────────── */}
      {(filterStatus === 'todos' || filterStatus === 'paid') && paid.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-medium text-sm">Histórico de pagamentos</h2>
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Venda</TableHead>
                  <TableHead className="text-xs">Pago em</TableHead>
                  <TableHead className="text-xs">Cliente</TableHead>
                  <TableHead className="text-xs">Bairro</TableHead>
                  <TableHead className="text-xs">Motoboy</TableHead>
                  <TableHead className="text-xs text-right">Fr. cobrado</TableHead>
                  <TableHead className="text-xs text-right">Repasse pago</TableHead>
                  <TableHead className="text-xs text-right">Taxa loja</TableHead>
                  <TableHead className="text-xs">Lote</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paid.map(item => {
                  const repasse = effectiveRepasse(item)
                  const fee     = adminFee(item)
                  return (
                    <TableRow key={item.id}>
                      <TableCell className="text-xs font-medium">
                        {item.sales?.sale_number ?? `#${item.id}`}
                      </TableCell>
                      <TableCell className="text-xs">
                        {item.repasse_paid_at ? formatDate(item.repasse_paid_at) : '—'}
                      </TableCell>
                      <TableCell className="text-xs">{item.customers?.name ?? '—'}</TableCell>
                      <TableCell className="text-xs">{item.customer_addresses?.neighborhood ?? '—'}</TableCell>
                      <TableCell className="text-xs">{item.motoboy ?? '—'}</TableCell>
                      <TableCell className="text-xs text-right">{formatCurrency(item.sales?.shipping_charged)}</TableCell>
                      <TableCell className="text-xs text-right text-green-600 font-medium">
                        {formatCurrency(repasse)}
                      </TableCell>
                      <TableCell className="text-xs text-right text-muted-foreground">
                        {fee != null ? formatCurrency(fee) : '—'}
                      </TableCell>
                      <TableCell>
                        {item.repasse_batch_id
                          ? (
                            <Badge variant="secondary" className="text-xs gap-1">
                              <Layers size={10} /> Lote #{item.repasse_batch_id}
                            </Badge>
                          )
                          : <span className="text-xs text-muted-foreground">Individual</span>
                        }
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {/* Confirmation dialog for missing motoboy */}
      {confirmPayload && (
        <ConfirmDialog
          payload={confirmPayload}
          onConfirm={() => {
            setConfirmPayload(null)
            handleFecharRepasse(true)
          }}
          onCancel={() => setConfirmPayload(null)}
        />
      )}
    </div>
  )
}
