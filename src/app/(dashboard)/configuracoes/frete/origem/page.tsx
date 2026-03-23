'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, MapPin, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface OriginForm {
  id?: number
  name: string
  cep: string
  street: string
  number: string
  complement: string
  neighborhood: string
  city: string
  state: string
  latitude: string
  longitude: string
  is_active: boolean
}

const EMPTY_FORM: OriginForm = {
  name: '',
  cep: '',
  street: '',
  number: '',
  complement: '',
  neighborhood: '',
  city: '',
  state: '',
  latitude: '',
  longitude: '',
  is_active: true,
}

export default function OrigemLogisticaPage() {
  const [form, setForm] = useState<OriginForm>(EMPTY_FORM)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [cepLoading, setCepLoading] = useState(false)

  useEffect(() => {
    async function loadOrigin() {
      try {
        const res = await fetch('/api/shipping/admin/origins')
        const data = await res.json()
        const origins = data.origins ?? data ?? []
        if (origins.length > 0) {
          const o = origins[0]
          setForm({
            id: o.id,
            name: o.name ?? '',
            cep: o.cep ?? '',
            street: o.street ?? '',
            number: o.number ?? '',
            complement: o.complement ?? '',
            neighborhood: o.neighborhood ?? '',
            city: o.city ?? '',
            state: o.state ?? '',
            latitude: o.latitude != null ? String(o.latitude) : '',
            longitude: o.longitude != null ? String(o.longitude) : '',
            is_active: o.is_active ?? true,
          })
        }
      } catch {
        toast.error('Erro ao carregar dados da origem')
      } finally {
        setLoading(false)
      }
    }
    loadOrigin()
  }, [])

  async function handleCepLookup(cep: string) {
    if (cep.length !== 8) return
    setCepLoading(true)
    try {
      const res = await fetch(`/api/shipping/cep?cep=${cep}`)
      if (!res.ok) return
      const data = await res.json()
      setForm((prev) => ({
        ...prev,
        street: data.street ?? data.logradouro ?? prev.street,
        neighborhood: data.neighborhood ?? data.bairro ?? prev.neighborhood,
        city: data.city ?? data.localidade ?? prev.city,
        state: data.state ?? data.uf ?? prev.state,
      }))
    } catch {
      // silently ignore CEP lookup errors
    } finally {
      setCepLoading(false)
    }
  }

  function handleChange(field: keyof OriginForm, value: string | boolean) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const payload = {
        name: form.name,
        cep: form.cep,
        street: form.street,
        number: form.number,
        complement: form.complement,
        neighborhood: form.neighborhood,
        city: form.city,
        state: form.state,
        latitude: form.latitude !== '' ? Number(form.latitude) : null,
        longitude: form.longitude !== '' ? Number(form.longitude) : null,
        is_active: form.is_active,
      }

      let res: Response
      if (form.id) {
        res = await fetch(`/api/shipping/admin/origins/${form.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } else {
        res = await fetch('/api/shipping/admin/origins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      }

      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Erro ao salvar origem')
      } else {
        toast.success('Origem logística salva com sucesso')
        if (!form.id && data.origin?.id) {
          setForm((prev) => ({ ...prev, id: data.origin.id }))
        }
      }
    } catch {
      toast.error('Erro de conexão ao salvar')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/configuracoes/frete"
          className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <MapPin className="w-5 h-5 text-brand" />
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Origem Logística</h2>
          <p className="text-sm text-text-muted">Endereço de saída das entregas</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="card p-5 space-y-5">
        {/* Nome da origem */}
        <Input
          label="Nome da origem"
          placeholder="Ex: Depósito Principal"
          value={form.name}
          onChange={(e) => handleChange('name', e.target.value)}
          required
        />

        {/* CEP */}
        <div className="relative">
          <Input
            label="CEP"
            placeholder="00000000"
            value={form.cep}
            onChange={(e) => {
              const val = e.target.value.replace(/\D/g, '').slice(0, 8)
              handleChange('cep', val)
              if (val.length === 8) handleCepLookup(val)
            }}
            maxLength={8}
            suffix={cepLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}
            hint="Digite o CEP para autocompletar o endereço"
            required
          />
        </div>

        {/* Rua e Número */}
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <Input
              label="Rua / Logradouro"
              placeholder="Nome da rua"
              value={form.street}
              onChange={(e) => handleChange('street', e.target.value)}
              required
            />
          </div>
          <Input
            label="Número"
            placeholder="123"
            value={form.number}
            onChange={(e) => handleChange('number', e.target.value)}
            required
          />
        </div>

        {/* Complemento */}
        <Input
          label="Complemento"
          placeholder="Apto, sala, bloco (opcional)"
          value={form.complement}
          onChange={(e) => handleChange('complement', e.target.value)}
        />

        {/* Bairro */}
        <Input
          label="Bairro"
          placeholder="Nome do bairro"
          value={form.neighborhood}
          onChange={(e) => handleChange('neighborhood', e.target.value)}
          required
        />

        {/* Cidade e Estado */}
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <Input
              label="Cidade"
              placeholder="Nome da cidade"
              value={form.city}
              onChange={(e) => handleChange('city', e.target.value)}
              required
            />
          </div>
          <Input
            label="Estado (UF)"
            placeholder="SP"
            maxLength={2}
            value={form.state}
            onChange={(e) => handleChange('state', e.target.value.toUpperCase())}
            required
          />
        </div>

        {/* Coordenadas */}
        <div>
          <p className="label-base mb-2">Coordenadas geográficas (opcional)</p>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Latitude"
              type="number"
              step="any"
              placeholder="-23.5505"
              value={form.latitude}
              onChange={(e) => handleChange('latitude', e.target.value)}
            />
            <Input
              label="Longitude"
              type="number"
              step="any"
              placeholder="-46.6333"
              value={form.longitude}
              onChange={(e) => handleChange('longitude', e.target.value)}
            />
          </div>
          <p className="mt-1 text-xs text-text-muted">Usado para calcular distâncias de entrega com precisão.</p>
        </div>

        {/* Ativo */}
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => handleChange('is_active', e.target.checked)}
            className="w-4 h-4 rounded border-border text-brand focus:ring-brand/50 bg-bg-overlay"
          />
          <div>
            <span className="text-sm font-medium text-text-primary">Origem ativa</span>
            <p className="text-xs text-text-muted">Somente origens ativas são usadas no cálculo de frete.</p>
          </div>
        </label>

        {/* Submit */}
        <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
          <Link href="/configuracoes/frete">
            <Button type="button" variant="secondary">
              Cancelar
            </Button>
          </Link>
          <Button type="submit" loading={saving}>
            {form.id ? 'Atualizar Origem' : 'Criar Origem'}
          </Button>
        </div>
      </form>
    </div>
  )
}
