'use client'

import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import { ArrowLeft, Plus, Trash2, Grid3X3 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

type VariationValue = {
  id:              number
  value:           string
  slug:            string
  sku_code:        string | null
  normalized_name: string | null
}
type VariationType = {
  id:               number
  name:             string
  slug:             string
  variation_values: VariationValue[]
}

export default function ConfigVariacoesPage() {
  const [types,    setTypes]    = useState<VariationType[]>([])
  const [loading,  setLoading]  = useState(true)
  const [adding,   setAdding]   = useState<Record<number, string>>({})
  const [saving,   setSaving]   = useState<Record<number, boolean>>({})
  const [deleting, setDeleting] = useState<Record<number, boolean>>({})
  const inputRefs = useRef<Record<number, HTMLInputElement | null>>({})

  async function loadTypes() {
    // cache: 'no-store' garante que o browser nunca sirva a resposta anterior
    const res  = await fetch('/api/variacoes', { cache: 'no-store' })
    const json = await res.json()

    if (!res.ok) {
      console.error('[variacoes] GET falhou:', json)
      toast.error('Erro ao carregar variações', { description: json.error ?? String(json) })
      setLoading(false)
      return  // mantém a lista anterior em vez de limpar tudo
    }

    setTypes(json.types ?? [])
    setLoading(false)
  }

  useEffect(() => { loadTypes() }, [])

  async function addValue(typeId: number) {
    const value = (adding[typeId] ?? '').trim()
    if (!value) return

    setSaving(p => ({ ...p, [typeId]: true }))
    const res  = await fetch('/api/variacoes/valores', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ variation_type_id: typeId, value }),
    })
    const json = await res.json()
    setSaving(p => ({ ...p, [typeId]: false }))

    if (!res.ok) {
      toast.error('Erro ao adicionar', { description: json.error })
      return
    }

    const code = json.value?.sku_code
    toast.success(`"${value}" adicionado!`, {
      description: code ? `Código SKU gerado: ${code}` : undefined,
    })
    setAdding(p => ({ ...p, [typeId]: '' }))
    await loadTypes()
    inputRefs.current[typeId]?.focus()
  }

  async function deleteValue(valueId: number, label: string) {
    if (!confirm(`Remover "${label}"? Isso pode afetar produtos existentes.`)) return
    setDeleting(p => ({ ...p, [valueId]: true }))
    const res  = await fetch(`/api/variacoes/valores?id=${valueId}`, { method: 'DELETE' })
    const json = await res.json()
    setDeleting(p => ({ ...p, [valueId]: false }))

    if (!res.ok) {
      toast.error('Erro ao remover', { description: json.error })
      return
    }
    toast.success(`"${label}" removido`)
    await loadTypes()
  }

  function handleKey(e: React.KeyboardEvent, typeId: number) {
    if (e.key === 'Enter') { e.preventDefault(); addValue(typeId) }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-text-muted">Carregando variações...</p>
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/configuracoes">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div className="flex items-center gap-2">
          <Grid3X3 className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Variações de Produto</h2>
            <p className="text-sm text-text-muted">Gerencie cores, tamanhos e outros atributos</p>
          </div>
        </div>
      </div>

      {/* Tipos de variação */}
      {types.map(type => (
        <div key={type.id} className="card p-6 space-y-4">
          {/* Cabeçalho do tipo */}
          <div className="flex items-center justify-between border-b border-border pb-3">
            <div>
              <h3 className="text-sm font-semibold text-text-primary">{type.name}</h3>
              <p className="text-xs text-text-muted">
                {type.variation_values.length} valor{type.variation_values.length !== 1 ? 'es' : ''} cadastrado{type.variation_values.length !== 1 ? 's' : ''}
              </p>
            </div>
            <span className="text-xs font-mono text-text-muted bg-bg-overlay px-2 py-1 rounded">
              {type.slug}
            </span>
          </div>

          {/* Lista de valores */}
          <div className="flex flex-wrap gap-2 min-h-[36px]">
            {type.variation_values.length === 0 ? (
              <p className="text-sm text-text-muted italic">Nenhum valor cadastrado ainda</p>
            ) : (
              type.variation_values.map(v => (
                <div
                  key={v.id}
                  className="group flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-bg-overlay border border-border text-sm font-medium text-text-primary hover:border-error/50 transition-all"
                >
                  <span>{v.value}</span>
                  {v.sku_code ? (
                    <span className="text-xs font-mono text-text-muted bg-bg-page px-1.5 py-0.5 rounded border border-border/50">
                      {v.sku_code}
                    </span>
                  ) : (
                    <span className="text-xs text-text-muted/50 italic">sem código</span>
                  )}
                  <button
                    onClick={() => deleteValue(v.id, v.value)}
                    disabled={deleting[v.id]}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-error ml-0.5"
                    title="Remover"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Input para adicionar novo valor */}
          <div className="flex gap-2 pt-1">
            <input
              ref={el => { inputRefs.current[type.id] = el }}
              type="text"
              className="input-base flex-1 text-sm"
              placeholder={`Adicionar ${type.name.toLowerCase()}... (ex: ${type.slug === 'cor' ? 'Azul Bebê' : type.slug === 'tamanho' ? 'G1' : 'novo valor'})`}
              value={adding[type.id] ?? ''}
              onChange={e => setAdding(p => ({ ...p, [type.id]: e.target.value }))}
              onKeyDown={e => handleKey(e, type.id)}
            />
            <Button
              type="button"
              size="sm"
              onClick={() => addValue(type.id)}
              loading={saving[type.id]}
              disabled={!(adding[type.id] ?? '').trim()}
            >
              <Plus className="w-4 h-4" />
              Adicionar
            </Button>
          </div>
          <p className="text-xs text-text-muted">
            Pressione{' '}
            <kbd className="px-1.5 py-0.5 rounded bg-bg-overlay border border-border font-mono text-xs">
              Enter
            </kbd>{' '}
            para adicionar rapidamente. O código SKU é gerado automaticamente.
          </p>
        </div>
      ))}

      {types.length === 0 && (
        <div className="card p-8 text-center space-y-2">
          <Grid3X3 className="w-8 h-8 text-text-muted mx-auto" />
          <p className="text-sm font-medium text-text-primary">Nenhum tipo de variação encontrado</p>
          <p className="text-xs text-text-muted">Execute o SQL de seed no Supabase para criar os tipos Cor e Tamanho.</p>
        </div>
      )}
    </div>
  )
}
