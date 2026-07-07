'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { ArrowLeft, ListChecks, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'

// ─── Tipos ────────────────────────────────────────────────────────────────────

type Category = { id: number; name: string }
type VariationType = { id: number; name: string; slug: string; kind: string }
type CategoryAttributeLink = {
  id: number
  category_id: number
  required: boolean
  active: boolean
  variation_type: VariationType
}

// ─── Componente ───────────────────────────────────────────────────────────────

export default function AtributosCategoriaPage() {
  const [categories, setCategories] = useState<Category[]>([])
  const [variationTypes, setVariationTypes] = useState<VariationType[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | ''>('')
  const [links, setLinks] = useState<CategoryAttributeLink[]>([])
  const [loadingInitial, setLoadingInitial] = useState(true)
  const [loadingLinks, setLoadingLinks] = useState(false)
  const [newTypeId, setNewTypeId] = useState<number | ''>('')
  const [adding, setAdding] = useState(false)
  const [savingId, setSavingId] = useState<number | null>(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/categorias').then(r => r.json()),
      fetch('/api/variacoes').then(r => r.json()),
    ]).then(([catsJson, varJson]) => {
      setCategories(catsJson.categories ?? [])
      setVariationTypes(varJson.types ?? [])
      setLoadingInitial(false)
    })
  }, [])

  const loadLinks = useCallback(async (categoryId: number) => {
    setLoadingLinks(true)
    const res = await fetch(`/api/category-attributes?category_id=${categoryId}`)
    const json = await res.json()
    setLoadingLinks(false)

    if (!res.ok) {
      toast.error('Erro ao carregar atributos', { description: json.error })
      return
    }
    setLinks(json.category_attributes ?? [])
  }, [])

  function handleSelectCategory(value: string) {
    const id = value ? Number(value) : ''
    setSelectedCategoryId(id)
    setNewTypeId('')
    setLinks([])
    if (id) loadLinks(id)
  }

  async function handleAdd() {
    if (!selectedCategoryId || !newTypeId) return
    setAdding(true)
    const res = await fetch('/api/category-attributes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category_id: selectedCategoryId, variation_type_id: newTypeId }),
    })
    const json = await res.json()
    setAdding(false)

    if (!res.ok) {
      toast.error('Erro ao adicionar atributo', { description: json.error })
      return
    }
    toast.success('Atributo vinculado!')
    setNewTypeId('')
    await loadLinks(selectedCategoryId)
  }

  async function handleToggleRequired(link: CategoryAttributeLink) {
    setSavingId(link.id)
    const res = await fetch(`/api/category-attributes/${link.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ required: !link.required }),
    })
    const json = await res.json()
    setSavingId(null)

    if (!res.ok) {
      toast.error('Erro ao atualizar', { description: json.error })
      return
    }
    if (selectedCategoryId) await loadLinks(selectedCategoryId)
  }

  async function handleDeactivate(link: CategoryAttributeLink) {
    if (!confirm(`Desativar o atributo "${link.variation_type.name}" para esta categoria?`)) return
    setSavingId(link.id)
    const res = await fetch(`/api/category-attributes/${link.id}`, { method: 'DELETE' })
    const json = await res.json()
    setSavingId(null)

    if (!res.ok) {
      toast.error('Erro ao desativar', { description: json.error })
      return
    }
    toast.success('Atributo desativado')
    if (selectedCategoryId) await loadLinks(selectedCategoryId)
  }

  async function handleReactivate(link: CategoryAttributeLink) {
    setSavingId(link.id)
    const res = await fetch(`/api/category-attributes/${link.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true }),
    })
    const json = await res.json()
    setSavingId(null)

    if (!res.ok) {
      toast.error('Erro ao reativar', { description: json.error })
      return
    }
    toast.success('Atributo reativado')
    if (selectedCategoryId) await loadLinks(selectedCategoryId)
  }

  // Tipos ainda não vinculados a esta categoria (ativos ou inativos) — evita
  // tentar recriar um vínculo já existente. Para trazer de volta um vínculo
  // inativo, o caminho é reativá-lo na própria linha, não criar de novo.
  const linkedTypeIds = new Set(links.map(l => l.variation_type.id))
  const availableTypes = variationTypes.filter(t => !linkedTypeIds.has(t.id))

  if (loadingInitial) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-text-muted">Carregando...</p>
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/configuracoes">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div className="flex items-center gap-2">
          <ListChecks className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Atributos por Categoria</h2>
            <p className="text-sm text-text-muted">Defina quais atributos se aplicam e são obrigatórios em cada categoria</p>
          </div>
        </div>
      </div>

      <div className="card p-6 space-y-4">
        <Select
          label="Categoria"
          value={selectedCategoryId}
          onChange={e => handleSelectCategory(e.target.value)}
        >
          <option value="">Selecione uma categoria</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </div>

      {selectedCategoryId !== '' && (
        <div className="card p-6 space-y-4">
          <h3 className="text-sm font-semibold text-text-primary border-b border-border pb-3">
            Atributos vinculados
          </h3>

          {loadingLinks ? (
            <p className="text-sm text-text-muted">Carregando...</p>
          ) : links.length === 0 ? (
            <p className="text-sm text-text-muted italic">Nenhum atributo vinculado a esta categoria ainda</p>
          ) : (
            <div className="divide-y divide-border">
              {links.map(link => (
                <div key={link.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`text-sm font-medium ${link.active ? 'text-text-primary' : 'text-text-muted line-through'}`}>
                      {link.variation_type.name}
                    </span>
                    <Badge variant={link.variation_type.kind === 'variant' ? 'brand' : 'outline'} size="sm">
                      {link.variation_type.kind === 'variant' ? 'Variação (gera SKU)' : 'Descritivo'}
                    </Badge>
                    {!link.active && <Badge variant="secondary" size="sm">Inativo</Badge>}
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    {link.active && (
                      <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
                        <input
                          type="checkbox"
                          checked={link.required}
                          disabled={savingId === link.id}
                          onChange={() => handleToggleRequired(link)}
                          className="w-3.5 h-3.5 rounded border-border accent-brand"
                        />
                        Obrigatório
                      </label>
                    )}
                    {link.active ? (
                      <Button
                        type="button" variant="danger" size="sm"
                        disabled={savingId === link.id}
                        onClick={() => handleDeactivate(link)}
                      >
                        Desativar
                      </Button>
                    ) : (
                      <Button
                        type="button" variant="outline" size="sm"
                        disabled={savingId === link.id}
                        onClick={() => handleReactivate(link)}
                      >
                        Reativar
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2 pt-2 border-t border-border">
            <div className="flex-1">
              <Select
                value={newTypeId}
                onChange={e => setNewTypeId(e.target.value ? Number(e.target.value) : '')}
              >
                <option value="">
                  {availableTypes.length === 0 ? 'Todos os atributos já vinculados' : 'Selecione um atributo para adicionar'}
                </option>
                {availableTypes.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.kind === 'variant' ? 'variação' : 'descritivo'})
                  </option>
                ))}
              </Select>
            </div>
            <Button type="button" size="sm" onClick={handleAdd} loading={adding} disabled={!newTypeId}>
              <Plus className="w-4 h-4" />
              Adicionar
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
