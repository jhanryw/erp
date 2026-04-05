'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Truck, MapPin, Map, Calculator, ArrowLeft, CheckCircle, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Modal } from '@/components/ui/modal'

interface ShippingZone {
  id: number
  name: string
  city: string
  is_active: boolean
  shipping_rules?: {
    client_price: number
    internal_cost: number
    free_shipping_min_order?: number
  }[]
}

interface SimulateResult {
  zone_name: string
  client_price: number
  internal_cost: number
  distance_km: number
  estimated_hours: number
  free_shipping_applied: boolean
}

export default function FreteConfigPage() {
  const [zones, setZones] = useState<ShippingZone[]>([])
  const [loadingZones, setLoadingZones] = useState(true)
  const [simulateOpen, setSimulateOpen] = useState(false)
  const [simCep, setSimCep] = useState('')
  const [simOrderValue, setSimOrderValue] = useState('')
  const [simLoading, setSimLoading] = useState(false)
  const [simResult, setSimResult] = useState<SimulateResult | null>(null)
  const [simError, setSimError] = useState<string | null>(null)

  useEffect(() => {
    async function loadZones() {
      try {
        const res = await fetch('/api/shipping/admin/zones')
        const data = await res.json()
        if (!res.ok) {
          toast.error('Erro ao carregar zonas', { description: data.error ?? `Status ${res.status}` })
          setZones([])
          return
        }
        const list = data.zones ?? data
        setZones(Array.isArray(list) ? list : [])
      } catch {
        toast.error('Erro ao carregar zonas de entrega')
        setZones([])
      } finally {
        setLoadingZones(false)
      }
    }
    loadZones()
  }, [])

  async function handleSimulate(e: React.FormEvent) {
    e.preventDefault()
    setSimError(null)
    setSimResult(null)
    setSimLoading(true)
    try {
      const res = await fetch('/api/shipping/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cep: simCep, order_value: Number(simOrderValue) }),
      })
      const data = await res.json()
      if (!res.ok) {
        setSimError(data.error ?? 'Erro ao calcular frete')
      } else {
        setSimResult(data)
      }
    } catch {
      setSimError('Erro de conexão ao calcular frete')
    } finally {
      setSimLoading(false)
    }
  }

  function handleSimulateClose() {
    setSimulateOpen(false)
    setSimResult(null)
    setSimError(null)
    setSimCep('')
    setSimOrderValue('')
  }

  const activeZones = zones.filter((z) => z.is_active)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/configuracoes"
          className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <Truck className="w-5 h-5 text-brand" />
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Configuração de Frete</h2>
          <p className="text-sm text-text-muted">Gerencie origens, zonas, regras e simule cálculos de frete</p>
        </div>
      </div>

      {/* Action cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Origem Logística */}
        <Link
          href="/configuracoes/frete/origem"
          className="card p-5 flex flex-col gap-4 hover:border-border-strong transition-all group"
        >
          <div className="flex items-start justify-between">
            <div className="p-2.5 rounded-xl bg-brand/10">
              <MapPin className="w-5 h-5 text-brand" />
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-primary mb-1">Origem Logística</h3>
            <p className="text-xs text-text-muted">Configure o endereço de saída das entregas e as coordenadas de localização.</p>
          </div>
          <span className="text-xs text-brand font-medium group-hover:underline">Configurar origem →</span>
        </Link>

        {/* Zonas de Entrega */}
        <Link
          href="/configuracoes/frete/zonas"
          className="card p-5 flex flex-col gap-4 hover:border-border-strong transition-all group"
        >
          <div className="flex items-start justify-between">
            <div className="p-2.5 rounded-xl bg-info/10">
              <Map className="w-5 h-5 text-info" />
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-primary mb-1">Zonas de Entrega</h3>
            <p className="text-xs text-text-muted">Defina zonas geográficas, bairros atendidos e regras de preço por zona.</p>
          </div>
          <span className="text-xs text-info font-medium group-hover:underline">Gerenciar zonas →</span>
        </Link>

        {/* Simular Cálculo */}
        <button
          onClick={() => setSimulateOpen(true)}
          className="card p-5 flex flex-col gap-4 hover:border-border-strong transition-all group text-left"
        >
          <div className="flex items-start justify-between">
            <div className="p-2.5 rounded-xl bg-success/10">
              <Calculator className="w-5 h-5 text-success" />
            </div>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-primary mb-1">Simular Cálculo</h3>
            <p className="text-xs text-text-muted">Teste o cálculo de frete por CEP e valor do pedido para verificar as regras.</p>
          </div>
          <span className="text-xs text-success font-medium group-hover:underline">Abrir simulador →</span>
        </button>
      </div>

      {/* Resumo das zonas ativas */}
      <div className="card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-primary">Resumo das Zonas Ativas</h3>
          <Badge variant="info">{activeZones.length} ativa{activeZones.length !== 1 ? 's' : ''}</Badge>
        </div>

        {loadingZones ? (
          <div className="py-6 text-center text-sm text-text-muted">Carregando zonas...</div>
        ) : activeZones.length === 0 ? (
          <div className="py-6 text-center">
            <Map className="w-8 h-8 text-text-muted mx-auto mb-2" />
            <p className="text-sm text-text-muted">Nenhuma zona ativa configurada.</p>
            <Link href="/configuracoes/frete/zonas" className="text-xs text-brand hover:underline mt-1 inline-block">
              Criar primeira zona →
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {activeZones.map((zone) => {
              const rule = zone.shipping_rules?.[0]
              return (
                <div key={zone.id} className="py-3 flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary">{zone.name}</p>
                    <p className="text-xs text-text-muted">{zone.city}</p>
                  </div>
                  <div className="text-right shrink-0">
                    {rule ? (
                      <div className="space-y-0.5">
                        <p className="text-sm font-semibold text-text-primary">
                          R$ {Number(rule.client_price).toFixed(2).replace('.', ',')}
                        </p>
                        {rule.free_shipping_min_order && (
                          <p className="text-[10px] text-success">
                            Grátis acima de R$ {Number(rule.free_shipping_min_order).toFixed(2).replace('.', ',')}
                          </p>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-text-muted italic">Sem regra</span>
                    )}
                  </div>
                  <Badge variant="success" size="sm">Ativa</Badge>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Modal de simulação */}
      <Modal
        open={simulateOpen}
        onClose={handleSimulateClose}
        title="Simular Cálculo de Frete"
        description="Insira o CEP de destino e o valor do pedido para testar as regras de frete."
        size="sm"
      >
        <form onSubmit={handleSimulate} className="space-y-4">
          <Input
            label="CEP de destino"
            placeholder="00000000"
            value={simCep}
            onChange={(e) => setSimCep(e.target.value.replace(/\D/g, '').slice(0, 8))}
            maxLength={8}
            required
          />
          <Input
            label="Valor do pedido (R$)"
            type="number"
            min="0"
            step="0.01"
            placeholder="0,00"
            value={simOrderValue}
            onChange={(e) => setSimOrderValue(e.target.value)}
            required
          />

          <Button type="submit" loading={simLoading} className="w-full">
            <Calculator className="w-4 h-4" />
            Calcular Frete
          </Button>
        </form>

        {simError && (
          <div className="mt-4 p-3 rounded-lg bg-error/10 border border-error/20 flex items-start gap-2">
            <XCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
            <p className="text-sm text-error">{simError}</p>
          </div>
        )}

        {simResult && (
          <div className="mt-4 p-4 rounded-xl bg-success/5 border border-success/20 space-y-3">
            <div className="flex items-center gap-2 mb-3">
              <CheckCircle className="w-4 h-4 text-success" />
              <span className="text-sm font-semibold text-success">Frete calculado com sucesso</span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-text-muted mb-0.5">Zona encontrada</p>
                <p className="font-medium text-text-primary">{simResult.zone_name}</p>
              </div>
              <div>
                <p className="text-xs text-text-muted mb-0.5">Distância</p>
                <p className="font-medium text-text-primary">{simResult.distance_km?.toFixed(1)} km</p>
              </div>
              <div>
                <p className="text-xs text-text-muted mb-0.5">Preço ao cliente</p>
                <p className="font-semibold text-text-primary">
                  {simResult.free_shipping_applied ? (
                    <span className="text-success">Grátis</span>
                  ) : (
                    `R$ ${Number(simResult.client_price).toFixed(2).replace('.', ',')}`
                  )}
                </p>
              </div>
              <div>
                <p className="text-xs text-text-muted mb-0.5">Custo interno</p>
                <p className="font-medium text-text-primary">
                  R$ {Number(simResult.internal_cost).toFixed(2).replace('.', ',')}
                </p>
              </div>
              <div>
                <p className="text-xs text-text-muted mb-0.5">Prazo estimado</p>
                <p className="font-medium text-text-primary">{simResult.estimated_hours}h</p>
              </div>
              <div>
                <p className="text-xs text-text-muted mb-0.5">Frete grátis aplicado</p>
                <Badge variant={simResult.free_shipping_applied ? 'success' : 'default'} size="sm">
                  {simResult.free_shipping_applied ? 'Sim' : 'Não'}
                </Badge>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
