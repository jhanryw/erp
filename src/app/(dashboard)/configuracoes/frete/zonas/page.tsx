'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Map, Plus, ChevronDown, ChevronRight,
  Edit2, Trash2, Loader2, AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Modal } from '@/components/ui/modal'

interface ShippingRule {
  id?: number
  client_price: string
  internal_cost: string
  estimated_hours: string
  free_shipping_min_order: string
  min_order_to_enable: string
  allow_pickup: boolean
  allow_delivery: boolean
}

interface ShippingZone {
  id: number
  name: string
  city: string
  neighborhoods_json?: string[]
  min_km?: number
  max_km?: number
  priority?: number
  color?: string
  is_active: boolean
  shipping_rules?: {
    id: number
    client_price: number
    internal_cost: number
    estimated_hours: number
    free_shipping_min_order?: number
    min_order_to_enable?: number
    allow_pickup: boolean
    allow_delivery: boolean
  }[]
}

const EMPTY_ZONE = {
  name: '',
  city: '',
  neighborhoods: '',
  min_km: '',
  max_km: '',
  priority: '100',
  color: '#6366f1',
  is_active: true,
}

const EMPTY_RULE: ShippingRule = {
  client_price: '',
  internal_cost: '',
  estimated_hours: '',
  free_shipping_min_order: '',
  min_order_to_enable: '',
  allow_pickup: false,
  allow_delivery: true,
}

export default function ZonasEntregaPage() {
  const [zones, setZones] = useState<ShippingZone[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  // Zone modal
  const [zoneModalOpen, setZoneModalOpen] = useState(false)
  const [editingZone, setEditingZone] = useState<ShippingZone | null>(null)
  const [zoneForm, setZoneForm] = useState(EMPTY_ZONE)
  const [savingZone, setSavingZone] = useState(false)

  // Rule section (shown after new zone created)
  const [newZoneId, setNewZoneId] = useState<number | null>(null)
  const [ruleForm, setRuleForm] = useState<ShippingRule>(EMPTY_RULE)
  const [savingRule, setSavingRule] = useState(false)
  const [ruleModalOpen, setRuleModalOpen] = useState(false)

  // Delete confirmation
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)

  async function loadZones() {
    try {
      const res = await fetch('/api/shipping/admin/zones')
      const data = await res.json()
      setZones(data.zones ?? data ?? [])
    } catch {
      toast.error('Erro ao carregar zonas')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadZones() }, [])

  function openCreate() {
    setEditingZone(null)
    setZoneForm(EMPTY_ZONE)
    setNewZoneId(null)
    setRuleForm(EMPTY_RULE)
    setZoneModalOpen(true)
  }

  function openEdit(zone: ShippingZone) {
    setEditingZone(zone)
    setZoneForm({
      name: zone.name,
      city: zone.city,
      neighborhoods: (zone.neighborhoods_json ?? []).join('\n'),
      min_km: zone.min_km != null ? String(zone.min_km) : '',
      max_km: zone.max_km != null ? String(zone.max_km) : '',
      priority: zone.priority != null ? String(zone.priority) : '100',
      color: zone.color ?? '#6366f1',
      is_active: zone.is_active,
    })
    setNewZoneId(null)
    setZoneModalOpen(true)
  }

  async function handleSaveZone(e: React.FormEvent) {
    e.preventDefault()
    setSavingZone(true)
    try {
      const payload = {
        name: zoneForm.name,
        city: zoneForm.city,
        neighborhoods_json: zoneForm.neighborhoods
          .split('\n')
          .map((n) => n.trim())
          .filter(Boolean),
        min_km: zoneForm.min_km !== '' ? Number(zoneForm.min_km) : null,
        max_km: zoneForm.max_km !== '' ? Number(zoneForm.max_km) : null,
        priority: zoneForm.priority !== '' ? Number(zoneForm.priority) : 100,
        color: zoneForm.color,
        is_active: zoneForm.is_active,
      }

      let res: Response
      if (editingZone) {
        res = await fetch(`/api/shipping/admin/zones/${editingZone.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } else {
        res = await fetch('/api/shipping/admin/zones', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      }

      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Erro ao salvar zona')
      } else {
        toast.success(editingZone ? 'Zona atualizada' : 'Zona criada')
        await loadZones()
        if (!editingZone) {
          const createdId = data.zone?.id ?? data.id
          if (createdId) {
            setNewZoneId(createdId)
            setRuleModalOpen(true)
          } else {
            setZoneModalOpen(false)
          }
        } else {
          setZoneModalOpen(false)
        }
      }
    } catch {
      toast.error('Erro de conexão ao salvar zona')
    } finally {
      setSavingZone(false)
    }
  }

  async function handleSaveRule(e: React.FormEvent) {
    e.preventDefault()
    if (!newZoneId) return
    setSavingRule(true)
    try {
      const payload = {
        zone_id: newZoneId,
        client_price: Number(ruleForm.client_price),
        internal_cost: Number(ruleForm.internal_cost),
        estimated_hours: Number(ruleForm.estimated_hours),
        free_shipping_min_order: ruleForm.free_shipping_min_order !== '' ? Number(ruleForm.free_shipping_min_order) : null,
        min_order_to_enable: ruleForm.min_order_to_enable !== '' ? Number(ruleForm.min_order_to_enable) : null,
        allow_pickup: ruleForm.allow_pickup,
        allow_delivery: ruleForm.allow_delivery,
      }
      const res = await fetch('/api/shipping/admin/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Erro ao salvar regra')
      } else {
        toast.success('Regra de preço salva')
        await loadZones()
        setRuleModalOpen(false)
        setZoneModalOpen(false)
        setNewZoneId(null)
      }
    } catch {
      toast.error('Erro de conexão ao salvar regra')
    } finally {
      setSavingRule(false)
    }
  }

  async function handleDelete() {
    if (!deleteId) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/shipping/admin/zones/${deleteId}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Erro ao excluir zona')
      } else {
        toast.success('Zona excluída')
        setZones((prev) => prev.filter((z) => z.id !== deleteId))
      }
    } catch {
      toast.error('Erro de conexão ao excluir')
    } finally {
      setDeleting(false)
      setDeleteId(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/configuracoes/frete"
            className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <Map className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Zonas de Entrega</h2>
            <p className="text-sm text-text-muted">{zones.length} zona{zones.length !== 1 ? 's' : ''} cadastrada{zones.length !== 1 ? 's' : ''}</p>
          </div>
        </div>
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4" />
          Nova Zona
        </Button>
      </div>

      {/* Zone list */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
        </div>
      ) : zones.length === 0 ? (
        <div className="card p-10 text-center">
          <Map className="w-10 h-10 text-text-muted mx-auto mb-3" />
          <p className="text-sm font-medium text-text-primary mb-1">Nenhuma zona cadastrada</p>
          <p className="text-xs text-text-muted mb-4">Crie a primeira zona de entrega para começar.</p>
          <Button onClick={openCreate} variant="outline" size="sm">
            <Plus className="w-4 h-4" />
            Criar Zona
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {zones.map((zone) => {
            const expanded = expandedId === zone.id
            const rule = zone.shipping_rules?.[0]
            return (
              <div key={zone.id} className="card overflow-hidden">
                {/* Zone header */}
                <button
                  onClick={() => setExpandedId(expanded ? null : zone.id)}
                  className="w-full flex items-center gap-3 p-4 hover:bg-white/[0.02] transition-colors text-left"
                >
                  <div
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: zone.color ?? '#6366f1' }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-text-primary">{zone.name}</span>
                      <span className="text-xs text-text-muted">{zone.city}</span>
                      {zone.min_km != null && zone.max_km != null && (
                        <span className="text-xs text-text-muted">
                          {zone.min_km}–{zone.max_km} km
                        </span>
                      )}
                    </div>
                    {zone.priority != null && (
                      <p className="text-xs text-text-muted mt-0.5">Prioridade: {zone.priority}</p>
                    )}
                  </div>
                  <Badge variant={zone.is_active ? 'success' : 'default'} size="sm">
                    {zone.is_active ? 'Ativa' : 'Inativa'}
                  </Badge>
                  {expanded ? (
                    <ChevronDown className="w-4 h-4 text-text-muted shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-text-muted shrink-0" />
                  )}
                </button>

                {/* Expanded details */}
                {expanded && (
                  <div className="border-t border-border p-4 space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {/* Bairros */}
                      <div>
                        <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Bairros atendidos</p>
                        {(zone.neighborhoods_json ?? []).length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {zone.neighborhoods_json!.map((n) => (
                              <Badge key={n} variant="outline" size="sm">{n}</Badge>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-text-muted italic">Nenhum bairro definido</p>
                        )}
                      </div>

                      {/* Regra de preço */}
                      <div>
                        <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Regra de preço</p>
                        {rule ? (
                          <div className="space-y-1 text-sm">
                            <div className="flex items-center justify-between">
                              <span className="text-text-muted text-xs">Preço cliente</span>
                              <span className="font-semibold text-text-primary">
                                R$ {Number(rule.client_price).toFixed(2).replace('.', ',')}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-text-muted text-xs">Custo interno</span>
                              <span className="font-medium text-text-secondary">
                                R$ {Number(rule.internal_cost).toFixed(2).replace('.', ',')}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-text-muted text-xs">Prazo</span>
                              <span className="text-text-secondary">{rule.estimated_hours}h</span>
                            </div>
                            {rule.free_shipping_min_order && (
                              <div className="flex items-center justify-between">
                                <span className="text-text-muted text-xs">Frete grátis acima de</span>
                                <Badge variant="success" size="sm">
                                  R$ {Number(rule.free_shipping_min_order).toFixed(2).replace('.', ',')}
                                </Badge>
                              </div>
                            )}
                            <div className="flex items-center gap-2 mt-1">
                              {rule.allow_delivery && <Badge variant="info" size="sm">Entrega</Badge>}
                              {rule.allow_pickup && <Badge variant="brand" size="sm">Retirada</Badge>}
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs text-text-muted italic">Sem regra de preço cadastrada</p>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 pt-2 border-t border-border">
                      <Button size="sm" variant="secondary" onClick={() => openEdit(zone)}>
                        <Edit2 className="w-3.5 h-3.5" />
                        Editar Zona
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setDeleteId(zone.id)}>
                        <Trash2 className="w-3.5 h-3.5" />
                        Excluir
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Zone create/edit modal */}
      <Modal
        open={zoneModalOpen && !ruleModalOpen}
        onClose={() => { setZoneModalOpen(false); setEditingZone(null) }}
        title={editingZone ? 'Editar Zona' : 'Nova Zona de Entrega'}
        size="md"
      >
        <form onSubmit={handleSaveZone} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Nome da zona"
              placeholder="Ex: Zona Sul"
              value={zoneForm.name}
              onChange={(e) => setZoneForm((p) => ({ ...p, name: e.target.value }))}
              required
            />
            <Input
              label="Cidade"
              placeholder="Ex: São Paulo"
              value={zoneForm.city}
              onChange={(e) => setZoneForm((p) => ({ ...p, city: e.target.value }))}
              required
            />
          </div>

          <div>
            <label className="label-base">Bairros (um por linha)</label>
            <textarea
              className="input-base min-h-[90px] resize-y mt-1"
              placeholder={"Jardim Paulista\nVila Madalena\nPinheiros"}
              value={zoneForm.neighborhoods}
              onChange={(e) => setZoneForm((p) => ({ ...p, neighborhoods: e.target.value }))}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Input
              label="Km mínimo"
              type="number"
              min="0"
              step="0.1"
              placeholder="0"
              value={zoneForm.min_km}
              onChange={(e) => setZoneForm((p) => ({ ...p, min_km: e.target.value }))}
            />
            <Input
              label="Km máximo"
              type="number"
              min="0"
              step="0.1"
              placeholder="10"
              value={zoneForm.max_km}
              onChange={(e) => setZoneForm((p) => ({ ...p, max_km: e.target.value }))}
            />
            <Input
              label="Prioridade"
              type="number"
              min="1"
              placeholder="100"
              value={zoneForm.priority}
              onChange={(e) => setZoneForm((p) => ({ ...p, priority: e.target.value }))}
            />
          </div>

          <div>
            <label className="label-base">Cor da zona</label>
            <div className="flex items-center gap-3 mt-1">
              <input
                type="color"
                value={zoneForm.color}
                onChange={(e) => setZoneForm((p) => ({ ...p, color: e.target.value }))}
                className="w-10 h-10 rounded-lg border border-border bg-bg-overlay cursor-pointer"
              />
              <span className="text-sm text-text-muted font-mono">{zoneForm.color}</span>
            </div>
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={zoneForm.is_active}
              onChange={(e) => setZoneForm((p) => ({ ...p, is_active: e.target.checked }))}
              className="w-4 h-4 rounded border-border text-brand focus:ring-brand/50 bg-bg-overlay"
            />
            <span className="text-sm font-medium text-text-primary">Zona ativa</span>
          </label>

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
            <Button type="button" variant="secondary" onClick={() => { setZoneModalOpen(false); setEditingZone(null) }}>
              Cancelar
            </Button>
            <Button type="submit" loading={savingZone}>
              {editingZone ? 'Salvar Alterações' : 'Criar Zona'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Rule modal (shown after new zone creation) */}
      <Modal
        open={ruleModalOpen}
        onClose={() => { setRuleModalOpen(false); setZoneModalOpen(false); setNewZoneId(null) }}
        title="Adicionar Regra de Preço"
        description="Configure os valores de frete para a nova zona criada."
        size="md"
      >
        <form onSubmit={handleSaveRule} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Preço ao cliente (R$)"
              type="number"
              min="0"
              step="0.01"
              placeholder="10,00"
              value={ruleForm.client_price}
              onChange={(e) => setRuleForm((p) => ({ ...p, client_price: e.target.value }))}
              required
            />
            <Input
              label="Custo interno (R$)"
              type="number"
              min="0"
              step="0.01"
              placeholder="8,00"
              value={ruleForm.internal_cost}
              onChange={(e) => setRuleForm((p) => ({ ...p, internal_cost: e.target.value }))}
              required
            />
          </div>

          <Input
            label="Prazo estimado (horas)"
            type="number"
            min="1"
            placeholder="2"
            value={ruleForm.estimated_hours}
            onChange={(e) => setRuleForm((p) => ({ ...p, estimated_hours: e.target.value }))}
            required
          />

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Frete grátis acima de (R$)"
              type="number"
              min="0"
              step="0.01"
              placeholder="Opcional"
              value={ruleForm.free_shipping_min_order}
              onChange={(e) => setRuleForm((p) => ({ ...p, free_shipping_min_order: e.target.value }))}
            />
            <Input
              label="Pedido mínimo para habilitar (R$)"
              type="number"
              min="0"
              step="0.01"
              placeholder="Opcional"
              value={ruleForm.min_order_to_enable}
              onChange={(e) => setRuleForm((p) => ({ ...p, min_order_to_enable: e.target.value }))}
            />
          </div>

          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={ruleForm.allow_delivery}
                onChange={(e) => setRuleForm((p) => ({ ...p, allow_delivery: e.target.checked }))}
                className="w-4 h-4 rounded border-border text-brand focus:ring-brand/50 bg-bg-overlay"
              />
              <span className="text-sm font-medium text-text-primary">Permitir entrega</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={ruleForm.allow_pickup}
                onChange={(e) => setRuleForm((p) => ({ ...p, allow_pickup: e.target.checked }))}
                className="w-4 h-4 rounded border-border text-brand focus:ring-brand/50 bg-bg-overlay"
              />
              <span className="text-sm font-medium text-text-primary">Permitir retirada</span>
            </label>
          </div>

          <div className="flex items-center justify-between gap-3 pt-2 border-t border-border">
            <Button
              type="button"
              variant="ghost"
              onClick={() => { setRuleModalOpen(false); setZoneModalOpen(false); setNewZoneId(null) }}
            >
              Pular por agora
            </Button>
            <Button type="submit" loading={savingRule}>
              Salvar Regra
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete confirmation modal */}
      <Modal
        open={deleteId !== null}
        onClose={() => setDeleteId(null)}
        title="Confirmar exclusão"
        size="sm"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-3 rounded-lg bg-error/10 border border-error/20">
            <AlertTriangle className="w-5 h-5 text-error shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-error">Esta ação não pode ser desfeita.</p>
              <p className="text-xs text-text-muted mt-0.5">
                A zona e todas as suas regras de preço serão permanentemente excluídas.
              </p>
            </div>
          </div>
          <div className="flex items-center justify-end gap-3">
            <Button variant="secondary" onClick={() => setDeleteId(null)}>
              Cancelar
            </Button>
            <Button variant="danger" loading={deleting} onClick={handleDelete}>
              <Trash2 className="w-4 h-4" />
              Excluir Zona
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
