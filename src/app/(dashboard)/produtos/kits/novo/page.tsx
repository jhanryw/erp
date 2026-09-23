'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, Boxes, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { KitComponentsEditor, type KitComponentDraft } from '@/components/produtos/kit-components-editor'

type Category = { id: number; name: string }
type VariationValue = { id: number; value: string }
type VariationType = { id: number; slug: string; variation_values: VariationValue[] }

type VariationForm = {
  key: string
  sku_variation: string
  price_override: string
  size_value_id: string
  color_value_id: string
  components: KitComponentDraft[]
}

function newVariation(): VariationForm {
  return {
    key: Math.random().toString(36).slice(2),
    sku_variation: '',
    price_override: '',
    size_value_id: '',
    color_value_id: '',
    components: [],
  }
}

/**
 * Cadastro de KIT: produto do catálogo (products.product_kind='kit') com
 * SKU e preço próprios e uma ou mais variações vendáveis, cada uma com a
 * sua composição. Tudo é gravado numa única transação no servidor
 * (POST /api/produtos/kits → rpc_create_kit_product).
 */
export default function NovoKitPage() {
  const router = useRouter()
  const [categories, setCategories] = useState<Category[]>([])
  const [types, setTypes] = useState<VariationType[]>([])
  const [saving, setSaving] = useState(false)

  const [name, setName] = useState('')
  const [sku, setSku] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [price, setPrice] = useState('')
  const [wholesalePrice, setWholesalePrice] = useState('')
  const [ncm, setNcm] = useState('')
  const [variations, setVariations] = useState<VariationForm[]>([newVariation()])

  useEffect(() => {
    Promise.all([
      fetch('/api/categorias').then((r) => r.json()),
      fetch('/api/variacoes').then((r) => r.json()),
    ]).then(([cats, vars]) => {
      setCategories(cats.categories ?? [])
      setTypes(vars.types ?? [])
    }).catch(() => toast.error('Erro ao carregar categorias/atributos'))
  }, [])

  const sizes = types.find((t) => t.slug === 'tamanho')?.variation_values ?? []
  const colors = types.find((t) => t.slug === 'cor')?.variation_values ?? []

  function patchVariation(key: string, patch: Partial<VariationForm>) {
    setVariations((vs) => vs.map((v) => (v.key === key ? { ...v, ...patch } : v)))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (variations.some((v) => v.components.length === 0)) {
      toast.error('Cada variação do kit precisa de pelo menos um componente.')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/produtos/kits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          sku,
          category_id: Number(categoryId),
          base_price: Number(price.replace(',', '.')),
          wholesale_price: wholesalePrice ? Number(wholesalePrice.replace(',', '.')) : null,
          ncm: ncm || null,
          variations: variations.map((v) => ({
            sku_variation: v.sku_variation,
            price_override: v.price_override ? Number(v.price_override.replace(',', '.')) : null,
            size_value_id: v.size_value_id ? Number(v.size_value_id) : null,
            color_value_id: v.color_value_id ? Number(v.color_value_id) : null,
            components: v.components.map((c) => ({
              component_product_variation_id: c.component_product_variation_id,
              quantity: c.quantity,
            })),
          })),
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error('Não foi possível criar o kit', { description: json.error })
        return
      }
      toast.success('Kit criado')
      router.push(`/produtos/${json.product.id}`)
    } catch {
      toast.error('Erro inesperado ao criar o kit')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-4xl space-y-6">
      <div className="space-y-2">
        <Link href="/produtos">
          <Button type="button" variant="outline" size="sm"><ArrowLeft className="mr-2 h-4 w-4" />Voltar</Button>
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Boxes className="h-6 w-6 text-brand" /> Novo kit
        </h1>
        <p className="text-sm text-text-muted">
          Um kit é vendido como um produto normal (SKU, preço, variações), mas não tem estoque próprio:
          a venda baixa os componentes e a disponibilidade é calculada a partir deles.
        </p>
      </div>

      <Card padding="md" className="space-y-4">
        <h2 className="text-sm font-semibold">Dados do kit</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Nome" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Kit 3 Calcinhas" />
          <Input label="SKU do kit" required value={sku} onChange={(e) => setSku(e.target.value.toUpperCase())} placeholder="KIT-3" />
          <Select label="Categoria" required value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Selecione…</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Input label="Preço de venda (R$)" required inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="49,90" />
          <Input label="Preço de atacado (R$, opcional)" inputMode="decimal" value={wholesalePrice} onChange={(e) => setWholesalePrice(e.target.value)} />
          <Input label="NCM (opcional)" inputMode="numeric" maxLength={8} value={ncm} onChange={(e) => setNcm(e.target.value.replace(/\D/g, ''))} hint="8 dígitos — necessário para emitir nota" />
        </div>
      </Card>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Variações vendáveis e composição</h2>
          <Button type="button" variant="secondary" size="sm" onClick={() => setVariations((vs) => [...vs, newVariation()])}>
            <Plus className="h-4 w-4" /> Adicionar variação
          </Button>
        </div>

        {variations.map((v, idx) => (
          <Card key={v.key} padding="md" className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-sm font-semibold">Variação {idx + 1}</h3>
              {variations.length > 1 && (
                <button type="button" onClick={() => setVariations((vs) => vs.filter((x) => x.key !== v.key))}
                  className="rounded-lg p-1.5 text-text-muted hover:bg-error/10 hover:text-error" aria-label="Remover variação">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-4">
              <Input id={`sku-${v.key}`} label="SKU da variação" required value={v.sku_variation}
                onChange={(e) => patchVariation(v.key, { sku_variation: e.target.value.toUpperCase() })} placeholder="KIT-PB-M" />
              <Select id={`tam-${v.key}`} label="Tamanho (opcional)" value={v.size_value_id} onChange={(e) => patchVariation(v.key, { size_value_id: e.target.value })}>
                <option value="">—</option>
                {sizes.map((s) => <option key={s.id} value={s.id}>{s.value}</option>)}
              </Select>
              <Select id={`cor-${v.key}`} label="Cor (opcional)" value={v.color_value_id} onChange={(e) => patchVariation(v.key, { color_value_id: e.target.value })}>
                <option value="">—</option>
                {colors.map((c) => <option key={c.id} value={c.id}>{c.value}</option>)}
              </Select>
              <Input id={`preco-${v.key}`} label="Preço próprio (opcional)" inputMode="decimal" value={v.price_override}
                onChange={(e) => patchVariation(v.key, { price_override: e.target.value })} placeholder="usa o do kit" />
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Composição do kit</p>
              <KitComponentsEditor value={v.components} onChange={(components) => patchVariation(v.key, { components })} />
            </div>
          </Card>
        ))}
      </div>

      <div className="flex justify-end gap-3">
        <Link href="/produtos"><Button type="button" variant="secondary">Cancelar</Button></Link>
        <Button type="submit" loading={saving}>Criar kit</Button>
      </div>
    </form>
  )
}
