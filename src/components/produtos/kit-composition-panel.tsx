'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Boxes } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { KitComponentsEditor, type KitComponentDraft } from './kit-components-editor'
import type { KitCompositionDetail } from '@/services/inventory/availability.service'

export function compositionToDrafts(detail: KitCompositionDetail | null | undefined): KitComponentDraft[] {
  return (detail?.components ?? []).map((c) => ({
    component_product_variation_id: c.component_product_variation_id,
    quantity: c.quantity,
    product_name: c.product_name,
    sku_variation: c.sku_variation,
    cor: c.cor,
    tamanho: c.tamanho,
    unit_cost: c.unit_cost,
    available_main_store: c.available_main_store,
    available_online: c.available_online,
  }))
}

interface Props {
  variationId: number
  sku: string
  label?: string | null
  initial: KitCompositionDetail | null
  editable?: boolean
}

/** "COMPOSIÇÃO DO KIT" de uma variação vendável — leitura ou edição (PUT atômico). */
export function KitCompositionPanel({ variationId, sku, label, initial, editable = false }: Props) {
  const [saved, setSaved] = useState<KitComponentDraft[]>(compositionToDrafts(initial))
  const [draft, setDraft] = useState<KitComponentDraft[]>(saved)
  const [saving, setSaving] = useState(false)

  const dirty = JSON.stringify(draft.map((d) => [d.component_product_variation_id, d.quantity]))
    !== JSON.stringify(saved.map((d) => [d.component_product_variation_id, d.quantity]))

  async function save() {
    if (draft.length === 0) {
      toast.error('O kit precisa ter pelo menos um componente.')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(`/api/produtos/kits/variacoes/${variationId}/componentes`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          components: draft.map((d) => ({ component_product_variation_id: d.component_product_variation_id, quantity: d.quantity })),
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error('Não foi possível salvar a composição', { description: json.error })
        return
      }
      const next = compositionToDrafts(json.composition)
      setSaved(next)
      setDraft(next)
      toast.success(`Composição de ${sku} salva`)
    } catch {
      toast.error('Erro inesperado ao salvar a composição')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Boxes className="h-4 w-4 text-brand" />
          Composição do kit · <code className="font-mono">{sku}</code>
          {label && <span className="font-normal text-text-muted">({label})</span>}
        </h4>
        {editable && dirty && (
          <div className="flex gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setDraft(saved)} disabled={saving}>Descartar</Button>
            <Button type="button" size="sm" onClick={save} loading={saving}>Salvar composição</Button>
          </div>
        )}
      </header>
      <KitComponentsEditor value={draft} onChange={editable ? setDraft : undefined} readOnly={!editable} />
      {editable && (
        <p className="text-[11px] text-text-muted">
          Alterar a composição não muda vendas já feitas — cada venda guarda a composição usada.
        </p>
      )}
    </section>
  )
}
