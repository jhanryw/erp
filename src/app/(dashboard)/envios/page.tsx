'use client'

import { useEffect, useState, useMemo } from 'react'
import { Package, ChevronDown, ChevronRight, Loader2, Search } from 'lucide-react'
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

interface Shipment {
  id: number
  order_id?: number
  delivery_mode: DeliveryMode
  status: ShipmentStatus
  distance_km?: number
  client_price?: number
  internal_cost?: number
  subsidy?: number
  motoboy?: string
  notes?: string
  created_at: string
  customers?: { id: number; name: string; phone?: string }
  customer_addresses?: { street: string; number: string; neighborhood: string; city: string; cep: string }
  shipping_zones?: { name: string; color?: string }
  shipping_rules?: { client_price: number; internal_cost: number }
}

const STATUS_CONFIG: Record<ShipmentStatus, { label: string; variant: 'warning' | 'info' | 'brand' | 'success' | 'error' | 'default' }> = {
  aguardando_confirmacao: { label: 'Ag. Confirmação', variant: 'warning' },
  aguardando_separacao: { label: 'Ag. Separação', variant: 'warning' },
  pronto_envio: { label: 'Pronto p/ Envio', variant: 'info' },
  aguardando_motoboy: { label: 'Ag. Motoboy', variant: 'info' },
  saiu_entrega: { label: 'Saiu p/ Entrega', variant: 'brand' },
  entregue: { label: 'Entregue', variant: 'success' },
  nao_entregue: { label: 'Não Entregue', variant: 'error' },
  aguardando_retirada: { label: 'Ag. Retirada', variant: 'warning' },
  retirado: { label: 'Retirado', variant: 'success' },
  cancelado: { label: 'Cancelado', variant: 'default' },
}

const ALL_STATUSES = Object.entries(STATUS_CONFIG) as [ShipmentStatus, typeof STATUS_CONFIG[ShipmentStatus]][]

function formatCurrency(value?: number | null) {
  if (value == null) return '—'
  return `R$ ${Number(value).toFixed(2).replace('.', ',')}`
}

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
  } catch {
    return '—'
  }
}

export default function EnviosPage() {
  const [shipments, setShipments] = useState<Shipment[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [updatingId, setUpdatingId] = useState<number | null>(null)

  // Filters
  const [filterStatus, setFilterStatus] = useState<string>('todos')
  const [filterMode, setFilterMode] = useState<string>('todos')
  const [filterSearch, setFilterSearch] = useState('')

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
        setShipments((prev) =>
          prev.map((s) => (s.id === id ? { ...s, status: newStatus } : s))
        )
        toast.success('Status atualizado')
      }
    } catch {
      toast.error('Erro de conexão ao atualizar')
    } finally {
      setUpdatingId(null)
    }
  }

  const filtered = useMemo(() => {
    return shipments.filter((s) => {
      if (filterStatus !== 'todos' && s.status !== filterStatus) return false
      if (filterMode !== 'todos' && s.delivery_mode !== filterMode) return false
      if (filterSearch) {
        const q = filterSearch.toLowerCase()
        const customerName = s.customers?.name?.toLowerCase() ?? ''
        const city = s.customer_addresses?.city?.toLowerCase() ?? ''
        const neighborhood = s.customer_addresses?.neighborhood?.toLowerCase() ?? ''
        const orderId = String(s.order_id ?? s.id)
        if (
          !customerName.includes(q) &&
          !city.includes(q) &&
          !neighborhood.includes(q) &&
          !orderId.includes(q)
        ) return false
      }
      return true
    })
  }, [shipments, filterStatus, filterMode, filterSearch])

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
          <p className="text-sm text-text-muted">Gerencie status de entrega e retirada dos pedidos</p>
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

        <select
          className="input-base w-auto"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="todos">Todos os status</option>
          {ALL_STATUSES.map(([value, cfg]) => (
            <option key={value} value={value}>{cfg.label}</option>
          ))}
        </select>

        <select
          className="input-base w-auto"
          value={filterMode}
          onChange={(e) => setFilterMode(e.target.value)}
        >
          <option value="todos">Todos os modos</option>
          <option value="delivery">Envio</option>
          <option value="pickup">Retirada</option>
        </select>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setFilterStatus('todos'); setFilterMode('todos'); setFilterSearch('') }}
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
                <TableHead align="right">Distância</TableHead>
                <TableHead align="right">Frete</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Data</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((shipment) => {
                const expanded = expandedId === shipment.id
                const statusCfg = STATUS_CONFIG[shipment.status] ?? { label: shipment.status, variant: 'default' as const }
                const address = shipment.customer_addresses
                const clientPrice = shipment.client_price ?? shipment.shipping_rules?.client_price

                return (
                  <>
                    <TableRow
                      key={`row-${shipment.id}`}
                      onClick={() => setExpandedId(expanded ? null : shipment.id)}
                      className="cursor-pointer"
                    >
                      <TableCell className="w-8">
                        {expanded ? (
                          <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 text-text-muted" />
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs text-text-muted">
                          #{shipment.order_id ?? shipment.id}
                        </span>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm font-medium text-text-primary">
                          {shipment.customers?.name ?? '—'}
                        </p>
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
                        ) : (
                          <span>—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={shipment.delivery_mode === 'delivery' ? 'info' : 'brand'}
                          size="sm"
                        >
                          {shipment.delivery_mode === 'delivery' ? 'Envio' : 'Retirada'}
                        </Badge>
                      </TableCell>
                      <TableCell align="right" muted>
                        {shipment.distance_km != null
                          ? `${Number(shipment.distance_km).toFixed(1)} km`
                          : '—'}
                      </TableCell>
                      <TableCell align="right">
                        <span className="font-medium text-text-primary">
                          {formatCurrency(clientPrice)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div onClick={(e) => e.stopPropagation()}>
                          {updatingId === shipment.id ? (
                            <Loader2 className="w-4 h-4 animate-spin text-text-muted" />
                          ) : (
                            <select
                              className="input-base py-1 text-xs w-auto"
                              value={shipment.status}
                              onChange={(e) =>
                                handleStatusChange(shipment.id, e.target.value as ShipmentStatus)
                              }
                            >
                              {ALL_STATUSES
                                .filter(([value]) => {
                                  // Para retirada, ocultar status exclusivos de entrega por motoboy
                                  if (shipment.delivery_mode === 'pickup') {
                                    return !['aguardando_separacao', 'pronto_envio', 'aguardando_motoboy', 'saiu_entrega', 'nao_entregue'].includes(value)
                                  }
                                  // Para envio, ocultar status exclusivos de retirada
                                  return value !== 'aguardando_retirada' && value !== 'retirado'
                                })
                                .map(([value, cfg]) => (
                                  <option key={value} value={value}>{cfg.label}</option>
                                ))
                              }
                            </select>
                          )}
                        </div>
                      </TableCell>
                      <TableCell muted>{formatDate(shipment.created_at)}</TableCell>
                    </TableRow>

                    {expanded && (
                      <TableRow key={`expand-${shipment.id}`} className="bg-white/[0.02]">
                        <TableCell colSpan={9} className="p-0">
                          <div className="px-10 py-4 grid grid-cols-1 sm:grid-cols-3 gap-4 border-t border-border/50">
                            {/* Endereço completo */}
                            <div>
                              <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
                                Endereço completo
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
                              <div className="space-y-1 text-sm">
                                <div className="flex justify-between gap-4">
                                  <span className="text-text-muted">Frete cobrado</span>
                                  <span className="font-medium text-text-primary">{formatCurrency(clientPrice)}</span>
                                </div>
                                <div className="flex justify-between gap-4">
                                  <span className="text-text-muted">Custo interno</span>
                                  <span className="text-text-secondary">
                                    {formatCurrency(shipment.internal_cost ?? shipment.shipping_rules?.internal_cost)}
                                  </span>
                                </div>
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

                            {/* Logística */}
                            <div>
                              <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
                                Logística
                              </p>
                              <div className="space-y-1 text-sm">
                                {shipment.motoboy ? (
                                  <div>
                                    <p className="text-text-muted text-xs">Motoboy</p>
                                    <p className="font-medium text-text-primary">{shipment.motoboy}</p>
                                  </div>
                                ) : (
                                  <p className="text-text-muted italic text-xs">Sem motoboy atribuído</p>
                                )}
                                {shipment.notes && (
                                  <div className="mt-2">
                                    <p className="text-text-muted text-xs">Observações</p>
                                    <p className="text-text-secondary text-xs mt-0.5">{shipment.notes}</p>
                                  </div>
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
