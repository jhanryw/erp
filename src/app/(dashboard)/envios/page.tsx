'use client'

import { useEffect, useState, useMemo } from 'react'
import { Package, ChevronDown, ChevronRight, Loader2, Search, CheckCircle2, Pencil, X } from 'lucide-react'
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

type ShipmentStatus =
  | 'aguardando_confirmacao'
  | 'aguardando_separacao'
  | 'pronto_envio'
  | 'aguardando_motoboy'
  | 'saiu_entrega'
  | 'entregue'
  | 'nao_entregue'
  | 'aguardando_retirada'
  | 'retirado'
  | 'cancelado'

type DeliveryMode = 'delivery' | 'pickup'
type RepasseStatus = 'pending' | 'paid' | 'not_applicable'

interface Shipment {
  id: number
  order_id?: number
  delivery_mode: DeliveryMode
  status: ShipmentStatus
  distance_km?: number
  client_price?: number
  internal_cost?: number
  internal_cost_real?: number
  repasse_amount?: number
  repasse_status?: RepasseStatus
  repasse_paid_at?: string
  repasse_finance_entry_id?: number
  subsidy?: number
  motoboy?: string
  courier_phone?: string
  notes?: string
  created_at: string
  customers?: { id: number; name: string; phone?: string }
  customer_addresses?: { street: string; number: string; neighborhood: string; city: string; cep: string }
  shipping_zones?: { name: string; color?: string }
  shipping_rules?: { client_price: number; internal_cost: number }
}

interface EditDraft {
  motoboy: string
  courier_phone: string
  notes: string
  internal_cost_real: string
  repasse_amount: string
}

const STATUS_CONFIG: Record<ShipmentStatus, { label: string; variant: 'warning' | 'info' | 'brand' | 'success' | 'error' | 'default' }> = {
  aguardando_confirmacao: { label: 'Ag. Confirmação',  variant: 'warning' },
  aguardando_separacao:   { label: 'Ag. Separação',    variant: 'warning' },
  pronto_envio:           { label: 'Pronto p/ Envio',  variant: 'info'    },
  aguardando_motoboy:     { label: 'Ag. Motoboy',      variant: 'info'    },
  saiu_entrega:           { label: 'Saiu p/ Entrega',  variant: 'brand'   },
  entregue:               { label: 'Entregue',          variant: 'success' },
  nao_entregue:           { label: 'Não Entregue',      variant: 'error'   },
  aguardando_retirada:    { label: 'Ag. Retirada',      variant: 'warning' },
  retirado:               { label: 'Retirado',          variant: 'success' },
  cancelado:              { label: 'Cancelado',          variant: 'default' },
}

const ALL_STATUSES = Object.entries(STATUS_CONFIG) as [ShipmentStatus, typeof STATUS_CONFIG[ShipmentStatus]][]

function formatCurrency(value?: number | null) {
  if (value == null) return '—'
  return `R$ ${Number(value).toFixed(2).replace('.', ',')}`
}

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
  } catch { return '—' }
}

function effectiveRepasse(s: Shipment): number | null {
  const v = s.internal_cost_real ?? s.repasse_amount ?? s.internal_cost ?? s.shipping_rules?.internal_cost
  return v != null ? Number(v) : null
}

function canPayRepasse(s: Shipment): boolean {
  if (s.delivery_mode !== 'delivery') return false
  if (s.repasse_status !== 'pending') return false
  const v = effectiveRepasse(s)
  return v != null && v > 0
}

export default function EnviosPage() {
  // Fase 2 (revisão) — Envios liberado para usuario (módulo completo,
  // inclusive custo interno de entrega e pagamento de repasse).
  const [shipments, setShipments]   = useState<Shipment[]>([])
  const [loading, setLoading]       = useState(true)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [updatingId, setUpdatingId] = useState<number | null>(null)
  const [editingId, setEditingId]   = useState<number | null>(null)
  const [editDraft, setEditDraft]   = useState<EditDraft>({ motoboy: '', courier_phone: '', notes: '', internal_cost_real: '', repasse_amount: '' })
  const [savingId, setSavingId]     = useState<number | null>(null)
  const [payingId, setPayingId]     = useState<number | null>(null)

  const [filterStatus, setFilterStatus]   = useState<string>('todos')
  const [filterMode, setFilterMode]       = useState<string>('todos')
  const [filterRepasse, setFilterRepasse] = useState<string>('todos')
  const [filterSearch, setFilterSearch]   = useState('')

  async function loadShipments() {
    try {
      const res = await fetch('/api/shipping/shipments')
      const data = await res.json()
      setShipments(data.shipments ?? [])
    } catch {
      toast.error('Erro ao carregar envios')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadShipments() }, [])

  async function handleStatusChange(id: number, newStatus: ShipmentStatus) {
    setUpdatingId(id)
    try {
      const res = await fetch(`/api/shipping/shipments/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Erro ao atualizar status')
      } else {
        setShipments((prev) => prev.map((s) => s.id === id ? { ...s, status: newStatus } : s))
        toast.success('Status atualizado')
      }
    } catch {
      toast.error('Erro de conexão ao atualizar')
    } finally {
      setUpdatingId(null)
    }
  }

  function handleEdit(shipment: Shipment) {
    setEditingId(shipment.id)
    setEditDraft({
      motoboy:            shipment.motoboy        ?? '',
      courier_phone:      shipment.courier_phone  ?? '',
      notes:              shipment.notes          ?? '',
      internal_cost_real: shipment.internal_cost_real != null ? String(shipment.internal_cost_real) : '',
      repasse_amount:     shipment.repasse_amount     != null ? String(shipment.repasse_amount)     : '',
    })
  }

  function handleCancelEdit() {
    setEditingId(null)
    setEditDraft({ motoboy: '', courier_phone: '', notes: '', internal_cost_real: '', repasse_amount: '' })
  }

  async function handleSave(id: number, shipment: Shipment) {
    const internal_cost_real = editDraft.internal_cost_real !== ''
      ? parseFloat(editDraft.internal_cost_real)
      : undefined
    const repasse_amount = editDraft.repasse_amount !== ''
      ? parseFloat(editDraft.repasse_amount)
      : undefined

    if (internal_cost_real !== undefined && (isNaN(internal_cost_real) || internal_cost_real <= 0)) {
      toast.error('Custo real deve ser maior que zero')
      return
    }
    if (repasse_amount !== undefined && (isNaN(repasse_amount) || repasse_amount <= 0)) {
      toast.error('Valor do repasse deve ser maior que zero')
      return
    }

    const payload: Record<string, unknown> = {
      motoboy:       editDraft.motoboy.trim()       || null,
      courier_phone: editDraft.courier_phone.trim() || null,
      notes:         editDraft.notes.trim()         || null,
    }
    if (internal_cost_real !== undefined) payload.internal_cost_real = internal_cost_real
    if (repasse_amount     !== undefined) payload.repasse_amount     = repasse_amount

    setSavingId(id)
    try {
      const res = await fetch(`/api/shipping/shipments/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Erro ao salvar')
        return
      }
      setShipments((prev) => prev.map((s) => s.id === id ? {
        ...s,
        motoboy:            (payload.motoboy       as string | null) ?? s.motoboy,
        courier_phone:      (payload.courier_phone as string | null) ?? s.courier_phone,
        notes:              (payload.notes         as string | null) ?? s.notes,
        ...(internal_cost_real !== undefined && { internal_cost_real }),
        ...(repasse_amount     !== undefined && { repasse_amount }),
      } : s))
      setEditingId(null)
      toast.success('Envio atualizado')
    } catch {
      toast.error('Erro de conexão')
    } finally {
      setSavingId(null)
    }
  }

  async function handlePagarRepasse(id: number) {
    const shipment = shipments.find((s) => s.id === id)
    const valor = effectiveRepasse(shipment!)
    if (!window.confirm(`Confirmar repasse de ${formatCurrency(valor)} ao motoboy?\nEssa ação cria um lançamento de despesa e não pode ser desfeita.`)) return

    setPayingId(id)
    try {
      const res = await fetch(`/api/shipping/shipments/${id}/repasse/pagar`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Erro ao registrar repasse')
        return
      }
      setShipments((prev) => prev.map((s) => s.id === id ? {
        ...s,
        repasse_status:           'paid',
        repasse_paid_at:          new Date().toISOString(),
        repasse_finance_entry_id: data.repasse?.finance_entry_id,
        repasse_amount:           data.repasse?.repasse_amount ?? s.repasse_amount,
      } : s))
      toast.success(`Repasse de ${formatCurrency(data.repasse?.repasse_amount)} registrado`)
    } catch {
      toast.error('Erro de conexão')
    } finally {
      setPayingId(null)
    }
  }

  const filtered = useMemo(() => {
    return shipments.filter((s) => {
      if (filterStatus  !== 'todos'  && s.status        !== filterStatus)  return false
      if (filterMode    !== 'todos'  && s.delivery_mode !== filterMode)    return false
      if (filterRepasse !== 'todos'  && s.repasse_status !== filterRepasse) return false
      if (filterSearch) {
        const q = filterSearch.toLowerCase()
        if (
          !(s.customers?.name?.toLowerCase().includes(q))       &&
          !(s.customer_addresses?.city?.toLowerCase().includes(q))          &&
          !(s.customer_addresses?.neighborhood?.toLowerCase().includes(q))  &&
          !String(s.order_id ?? s.id).includes(q)
        ) return false
      }
      return true
    })
  }, [shipments, filterStatus, filterMode, filterRepasse, filterSearch])

  const pendingRepasseCount = shipments.filter(
    (s) => s.delivery_mode === 'delivery' && s.repasse_status === 'pending'
  ).length

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Package className="w-5 h-5 text-brand" />
        <div>
          <h2 className="text-lg font-semibold text-text-primary">
            Envios
            {!loading && (
              <span className="ml-2 text-sm font-normal text-text-muted">
                ({shipments.length})
              </span>
            )}
          </h2>
          <p className="text-sm text-text-muted">
            Gerencie entregas, retiradas e repasse ao motoboy
            {pendingRepasseCount > 0 && (
              <span className="ml-2 font-medium text-warning">
                · {pendingRepasseCount} repasse{pendingRepasseCount > 1 ? 's' : ''} pendente{pendingRepasseCount > 1 ? 's' : ''}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[200px]">
          <Input
            placeholder="Buscar por cliente, cidade, bairro ou pedido..."
            value={filterSearch}
            onChange={(e) => setFilterSearch(e.target.value)}
            prefix={<Search className="w-3.5 h-3.5" />}
          />
        </div>

        <select className="input-base w-auto" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="todos">Todos os status</option>
          {ALL_STATUSES.map(([value, cfg]) => (
            <option key={value} value={value}>{cfg.label}</option>
          ))}
        </select>

        <select className="input-base w-auto" value={filterMode} onChange={(e) => setFilterMode(e.target.value)}>
          <option value="todos">Todos os modos</option>
          <option value="delivery">Envio</option>
          <option value="pickup">Retirada</option>
        </select>

        <select className="input-base w-auto" value={filterRepasse} onChange={(e) => setFilterRepasse(e.target.value)}>
          <option value="todos">Repasse: todos</option>
          <option value="pending">Repasse pendente</option>
          <option value="paid">Repasse pago</option>
          <option value="not_applicable">Retirada</option>
        </select>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setFilterStatus('todos'); setFilterMode('todos'); setFilterRepasse('todos'); setFilterSearch('') }}
        >
          Limpar
        </Button>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center">
            <Package className="w-10 h-10 text-text-muted mx-auto mb-3" />
            <p className="text-sm font-medium text-text-primary mb-1">Nenhum envio encontrado</p>
            <p className="text-xs text-text-muted">
              {shipments.length === 0
                ? 'Os envios aparecerão aqui quando pedidos forem realizados.'
                : 'Tente ajustar os filtros de busca.'}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead></TableHead>
                <TableHead>Pedido</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Endereço</TableHead>
                <TableHead>Modo</TableHead>
                <TableHead align="right">Frete</TableHead>
                <TableHead>Status entrega</TableHead>
                <TableHead>Repasse</TableHead>
                <TableHead>Data</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((shipment) => {
                const expanded   = expandedId === shipment.id
                const isEditing  = editingId  === shipment.id
                const statusCfg  = STATUS_CONFIG[shipment.status] ?? { label: shipment.status, variant: 'default' as const }
                const address    = shipment.customer_addresses
                const clientPrice = shipment.client_price ?? shipment.shipping_rules?.client_price
                const repasse    = effectiveRepasse(shipment)

                return (
                  <>
                    <TableRow
                      key={`row-${shipment.id}`}
                      onClick={() => {
                        if (isEditing) return
                        setExpandedId(expanded ? null : shipment.id)
                      }}
                      className="cursor-pointer"
                    >
                      <TableCell className="w-8">
                        {expanded
                          ? <ChevronDown  className="w-3.5 h-3.5 text-text-muted" />
                          : <ChevronRight className="w-3.5 h-3.5 text-text-muted" />}
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs text-text-muted">#{shipment.order_id ?? shipment.id}</span>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm font-medium text-text-primary">{shipment.customers?.name ?? '—'}</p>
                        {shipment.customers?.phone && (
                          <p className="text-xs text-text-muted">{shipment.customers.phone}</p>
                        )}
                      </TableCell>
                      <TableCell muted>
                        {address ? (
                          <div>
                            <p className="text-sm">{address.city}</p>
                            <p className="text-xs text-text-muted">{address.neighborhood}</p>
                          </div>
                        ) : '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={shipment.delivery_mode === 'delivery' ? 'info' : 'brand'} size="sm">
                          {shipment.delivery_mode === 'delivery' ? 'Envio' : 'Retirada'}
                        </Badge>
                      </TableCell>
                      <TableCell align="right">
                        <span className="font-medium text-text-primary">{formatCurrency(clientPrice)}</span>
                      </TableCell>
                      <TableCell>
                        <div onClick={(e) => e.stopPropagation()}>
                          {updatingId === shipment.id ? (
                            <Loader2 className="w-4 h-4 animate-spin text-text-muted" />
                          ) : (
                            <select
                              className="input-base py-1 text-xs w-auto"
                              value={shipment.status}
                              onChange={(e) => handleStatusChange(shipment.id, e.target.value as ShipmentStatus)}
                            >
                              {ALL_STATUSES
                                .filter(([value]) => {
                                  if (shipment.delivery_mode === 'pickup') {
                                    return !['aguardando_separacao','pronto_envio','aguardando_motoboy','saiu_entrega','nao_entregue'].includes(value)
                                  }
                                  return value !== 'aguardando_retirada' && value !== 'retirado'
                                })
                                .map(([value, cfg]) => (
                                  <option key={value} value={value}>{cfg.label}</option>
                                ))}
                            </select>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {shipment.delivery_mode === 'delivery' ? (
                          shipment.repasse_status === 'paid' ? (
                            <span className="flex items-center gap-1 text-xs text-success font-medium">
                              <CheckCircle2 className="w-3.5 h-3.5" /> Pago
                            </span>
                          ) : repasse != null && repasse > 0 ? (
                            <span className="text-xs text-warning font-medium">
                              {formatCurrency(repasse)}
                            </span>
                          ) : (
                            <span className="text-xs text-text-muted">—</span>
                          )
                        ) : (
                          <span className="text-xs text-text-muted">—</span>
                        )}
                      </TableCell>
                      <TableCell muted>{formatDate(shipment.created_at)}</TableCell>
                    </TableRow>

                    {expanded && (
                      <TableRow key={`expand-${shipment.id}`} className="bg-white/[0.02]">
                        <TableCell colSpan={9} className="p-0">
                          <div className="px-10 py-5 space-y-5 border-t border-border/50">

                            {/* 3-col detail grid */}
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">

                              {/* Endereço */}
                              <div>
                                <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
                                  Endereço
                                </p>
                                {address ? (
                                  <div className="text-sm text-text-secondary space-y-0.5">
                                    <p>{address.street}, {address.number}</p>
                                    <p>{address.neighborhood}</p>
                                    <p>{address.city} — CEP {address.cep}</p>
                                  </div>
                                ) : (
                                  <p className="text-sm text-text-muted italic">
                                    {shipment.delivery_mode === 'pickup' ? 'Retirada no local' : 'Endereço não cadastrado'}
                                  </p>
                                )}
                              </div>

                              {/* Financeiro */}
                              <div>
                                <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
                                  Financeiro
                                </p>
                                <div className="space-y-2 text-sm">
                                  <div className="flex justify-between gap-4">
                                    <span className="text-text-muted">Frete cobrado</span>
                                    <span className="font-medium text-text-primary">{formatCurrency(clientPrice)}</span>
                                  </div>

                                  <div className="flex justify-between gap-4">
                                    <span className="text-text-muted">Custo estimado</span>
                                    <span className="text-text-secondary">
                                      {formatCurrency(shipment.internal_cost ?? shipment.shipping_rules?.internal_cost)}
                                    </span>
                                  </div>

                                  {shipment.delivery_mode === 'delivery' && (
                                    <>
                                      <div className="flex justify-between items-center gap-4">
                                        <span className="text-text-muted">Custo real</span>
                                        {isEditing ? (
                                          <input
                                            type="number"
                                            step="0.01"
                                            min="0.01"
                                            placeholder="0,00"
                                            className="input-base py-0.5 text-right w-24 text-sm"
                                            value={editDraft.internal_cost_real}
                                            onChange={(e) => setEditDraft((d) => ({ ...d, internal_cost_real: e.target.value }))}
                                          />
                                        ) : (
                                          <span className="text-text-secondary">
                                            {formatCurrency(shipment.internal_cost_real)}
                                          </span>
                                        )}
                                      </div>

                                      <div className="flex justify-between items-center gap-4">
                                        <span className="text-text-muted">
                                          Repasse
                                          {shipment.internal_cost_real == null && (
                                            <span className="text-text-muted text-xs"> (fallback)</span>
                                          )}
                                        </span>
                                        {isEditing ? (
                                          <input
                                            type="number"
                                            step="0.01"
                                            min="0.01"
                                            placeholder="0,00"
                                            className="input-base py-0.5 text-right w-24 text-sm"
                                            value={editDraft.repasse_amount}
                                            disabled={editDraft.internal_cost_real !== ''}
                                            title={editDraft.internal_cost_real !== '' ? 'Ignorado: custo real está preenchido' : undefined}
                                            onChange={(e) => setEditDraft((d) => ({ ...d, repasse_amount: e.target.value }))}
                                          />
                                        ) : (
                                          <span className="text-text-secondary">
                                            {formatCurrency(shipment.repasse_amount)}
                                          </span>
                                        )}
                                      </div>

                                      <div className="pt-0.5">
                                        {shipment.repasse_status === 'paid' ? (
                                          <Badge variant="success" size="sm">
                                            Repasse pago {shipment.repasse_paid_at
                                              ? formatDate(shipment.repasse_paid_at)
                                              : ''}
                                          </Badge>
                                        ) : shipment.repasse_status === 'pending' ? (
                                          <Badge variant="warning" size="sm">Repasse pendente</Badge>
                                        ) : null}
                                      </div>
                                    </>
                                  )}

                                  {shipment.subsidy != null && (
                                    <div className="flex justify-between gap-4">
                                      <span className="text-text-muted">Subsídio</span>
                                      <span className="text-error">{formatCurrency(shipment.subsidy)}</span>
                                    </div>
                                  )}

                                  {shipment.shipping_zones && (
                                    <div className="flex items-center gap-2 mt-1">
                                      <div
                                        className="w-2 h-2 rounded-full"
                                        style={{ backgroundColor: shipment.shipping_zones.color ?? '#6366f1' }}
                                      />
                                      <span className="text-text-muted text-xs">{shipment.shipping_zones.name}</span>
                                    </div>
                                  )}
                                </div>
                              </div>

                              {/* Logística / Motoboy */}
                              <div>
                                <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
                                  Logística
                                </p>
                                {isEditing ? (
                                  <div className="space-y-2">
                                    <div>
                                      <label className="text-xs text-text-muted block mb-1">Motoboy</label>
                                      <Input
                                        placeholder="Nome do motoboy"
                                        value={editDraft.motoboy}
                                        onChange={(e) => setEditDraft((d) => ({ ...d, motoboy: e.target.value }))}
                                      />
                                    </div>
                                    <div>
                                      <label className="text-xs text-text-muted block mb-1">Telefone / WhatsApp</label>
                                      <Input
                                        placeholder="(85) 99999-0000"
                                        value={editDraft.courier_phone}
                                        onChange={(e) => setEditDraft((d) => ({ ...d, courier_phone: e.target.value }))}
                                      />
                                    </div>
                                    <div>
                                      <label className="text-xs text-text-muted block mb-1">Observações</label>
                                      <Input
                                        placeholder="..."
                                        value={editDraft.notes}
                                        onChange={(e) => setEditDraft((d) => ({ ...d, notes: e.target.value }))}
                                      />
                                    </div>
                                  </div>
                                ) : (
                                  <div className="space-y-2 text-sm">
                                    {shipment.motoboy ? (
                                      <div>
                                        <p className="text-text-muted text-xs">Motoboy</p>
                                        <p className="font-medium text-text-primary">{shipment.motoboy}</p>
                                        {shipment.courier_phone && (
                                          <p className="text-xs text-text-muted">{shipment.courier_phone}</p>
                                        )}
                                      </div>
                                    ) : (
                                      <p className="text-text-muted italic text-xs">Sem motoboy atribuído</p>
                                    )}
                                    {shipment.notes && (
                                      <div>
                                        <p className="text-text-muted text-xs">Observações</p>
                                        <p className="text-text-secondary text-xs mt-0.5">{shipment.notes}</p>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* Action bar */}
                            <div className="flex items-center justify-between gap-3 pt-3 border-t border-border/40">
                              {/* Edit hint / info */}
                              <div className="text-xs text-text-muted">
                                {isEditing && shipment.delivery_mode === 'delivery' && (
                                  <span>
                                    {editDraft.internal_cost_real !== ''
                                      ? 'Custo real definido — campo "Repasse" ignorado.'
                                      : 'Preencha "Custo real" para sobrepor o valor do repasse.'}
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-2">
                                {isEditing ? (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={handleCancelEdit}
                                      disabled={savingId === shipment.id}
                                    >
                                      <X className="w-3.5 h-3.5 mr-1" />
                                      Cancelar
                                    </Button>
                                    <Button
                                      size="sm"
                                      onClick={() => handleSave(shipment.id, shipment)}
                                      disabled={savingId === shipment.id}
                                    >
                                      {savingId === shipment.id
                                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                        : 'Salvar'}
                                    </Button>
                                  </>
                                ) : (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => handleEdit(shipment)}
                                    >
                                      <Pencil className="w-3.5 h-3.5 mr-1" />
                                      Editar
                                    </Button>

                                    {canPayRepasse(shipment) && (
                                      <Button
                                        size="sm"
                                        disabled={payingId === shipment.id}
                                        onClick={() => handlePagarRepasse(shipment.id)}
                                        className="bg-success/10 text-success border border-success/30 hover:bg-success/20"
                                      >
                                        {payingId === shipment.id
                                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                          : (
                                            <>
                                              <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                                              Marcar repasse como pago ({formatCurrency(effectiveRepasse(shipment))})
                                            </>
                                          )}
                                      </Button>
                                    )}

                                    {shipment.repasse_status === 'paid' && (
                                      <span className="text-xs text-success flex items-center gap-1 font-medium">
                                        <CheckCircle2 className="w-3.5 h-3.5" />
                                        Repasse pago
                                      </span>
                                    )}
                                  </>
                                )}
                              </div>
                            </div>

                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}
