'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

const ORIGINS = [
  { value: '',             label: 'Sem origem' },
  { value: 'instagram',   label: 'Instagram' },
  { value: 'paid_traffic',label: 'Tráfego Pago' },
  { value: 'referral',    label: 'Indicação' },
  { value: 'website',     label: 'Site' },
  { value: 'store',       label: 'Loja Física' },
  { value: 'other',       label: 'Outro' },
]

interface Props {
  sale: {
    id:          number
    sale_number: string
    sale_origin: string | null
    notes:       string | null
    sale_date:   string
    status:      string
  }
}

export function EditSaleForm({ sale }: Props) {
  const router = useRouter()
  const [origin,   setOrigin]   = useState(sale.sale_origin ?? '')
  const [notes,    setNotes]    = useState(sale.notes ?? '')
  const [saleDate, setSaleDate] = useState(sale.sale_date.slice(0, 10))
  const [loading,  setLoading]  = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await fetch(`/api/vendas/${sale.id}/editar`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sale_origin: origin || null,
          notes:       notes.trim() || null,
          sale_date:   saleDate,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        const msg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error)
        toast.error('Erro ao salvar', { description: msg })
        return
      }
      toast.success('Venda atualizada!')
      router.push(`/vendas/${sale.id}`)
      router.refresh()
    } catch {
      toast.error('Erro inesperado')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card p-5 space-y-5">

      {/* Origem */}
      <Select
        label="Origem da Venda"
        value={origin}
        onChange={e => setOrigin(e.target.value)}
      >
        {ORIGINS.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </Select>

      {/* Data */}
      <Input
        label="Data da Venda"
        type="date"
        value={saleDate}
        onChange={e => setSaleDate(e.target.value)}
      />

      {/* Observações */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-text-secondary">Observações</label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Opcional"
          maxLength={1000}
          rows={3}
          className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand/40 resize-none"
        />
      </div>

      <div className="flex gap-3 pt-1">
        <Button
          type="button"
          variant="secondary"
          className="flex-1 h-11"
          onClick={() => router.back()}
        >
          Cancelar
        </Button>
        <Button type="submit" loading={loading} className="flex-1 h-11">
          <Save className="w-4 h-4" />
          Salvar
        </Button>
      </div>
    </form>
  )
}
