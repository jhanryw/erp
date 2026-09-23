'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { KitComponentsEditor, type KitComponentDraft } from './kit-components-editor'

type VariationValue = { id: number; value: string }

interface Props {
  productId: number
  sizes: VariationValue[]
  colors: VariationValue[]
  onCreated: () => void
}

/** Nova variação vendável de um kit existente: SKU próprio + composição (POST atômico). */
export function KitAddVariation({ productId, sizes, colors, onCreated }: Props) {
  const [open, setOpen] = useState(false)
  const [sku, setSku] = useState('')
  const [price, setPrice] = useState('')
  const [sizeId, setSizeId] = useState('')
  const [colorId, setColorId] = useState('')
  const [components, setComponents] = useState<KitComponentDraft[]>([])
  const [saving, setSaving] = useState(false)

  async function create() {
    if (sku.trim().length < 2) {
      toast.error('Informe o SKU da variação do kit.')
      return
    }
    if (components.length === 0) {
      toast.error('A variação precisa de pelo menos um componente.')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/produtos/kits/${productId}/variacoes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variations: [{
            sku_variation: sku.trim(),
            price_override: price ? Number(price.replace(',', '.')) : null,
            size_value_id: sizeId ? Number(sizeId) : null,
            color_value_id: colorId ? Number(colorId) : null,
            components: components.map((c) => ({ component_product_variation_id: c.component_product_variation_id, quantity: c.quantity })),
          }],
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error('Não foi possível adicionar a variação', { description: json.error })
        return
      }
      toast.success(`Variação ${sku.trim()} adicionada ao kit`)
      setSku(''); setPrice(''); setSizeId(''); setColorId(''); setComponents([]); setOpen(false)
      onCreated()
    } catch {
      toast.error('Erro inesperado ao adicionar a variação')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center justify-between px-6 py-4 text-sm font-semibold text-text-primary transition-colors hover:bg-bg-hover"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-2"><Plus className="h-4 w-4" />Adicionar variação ao kit</span>
        <ChevronDown className={`h-4 w-4 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="space-y-4 border-t border-border px-6 pb-6 pt-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label-base" htmlFor="kit-new-sku">SKU da variação</label>
              <input id="kit-new-sku" className="input-base" value={sku} placeholder="KIT-PB-G"
                onChange={(e) => setSku(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }} />
            </div>
            <div>
              <label className="label-base" htmlFor="kit-new-price">Preço próprio (opcional)</label>
              <input id="kit-new-price" className="input-base" inputMode="decimal" value={price} placeholder="usa o do kit"
                onChange={(e) => setPrice(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }} />
            </div>
            <div>
              <label className="label-base" htmlFor="kit-new-size">Tamanho (opcional)</label>
              <select id="kit-new-size" className="input-base" value={sizeId} onChange={(e) => setSizeId(e.target.value)}>
                <option value="">—</option>
                {sizes.map((s) => <option key={s.id} value={s.id}>{s.value}</option>)}
              </select>
            </div>
            <div>
              <label className="label-base" htmlFor="kit-new-color">Cor (opcional)</label>
              <select id="kit-new-color" className="input-base" value={colorId} onChange={(e) => setColorId(e.target.value)}>
                <option value="">—</option>
                {colors.map((c) => <option key={c.id} value={c.id}>{c.value}</option>)}
              </select>
            </div>
          </div>
          <KitComponentsEditor value={components} onChange={setComponents} />
          <Button type="button" size="sm" onClick={create} loading={saving}>
            <Plus className="h-4 w-4" /> Criar variação do kit
          </Button>
        </div>
      )}
    </div>
  )
}
