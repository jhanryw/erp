'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { toast } from 'sonner'
import { ImagePlus, ImageOff, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

const ACCEPTED_MIME = 'image/jpeg,image/png,image/webp'

interface CategoryRow {
  id: number
  name: string
  key: string
  active: boolean
  cover: { url: string; alt: string | null; mediaPublicId: string } | null
}

export function CategoryCoverManager() {
  const [categories, setCategories] = useState<CategoryRow[] | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const targetRef = useRef<number | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/configuracoes/atacado/categorias')
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setCategories(json.categories)
    } catch {
      toast.error('Não foi possível carregar as categorias')
      setCategories([])
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    const categoryId = targetRef.current
    if (!file || categoryId == null) return

    setBusyId(categoryId)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('visibility', 'public')
      const upload = await fetch('/api/media', { method: 'POST', body: formData })
      const uploadJson = await upload.json().catch(() => ({}))
      if (!upload.ok) {
        toast.error('Erro ao enviar imagem', { description: uploadJson.error })
        return
      }

      const res = await fetch(`/api/configuracoes/atacado/categorias/${categoryId}/capa`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaPublicId: uploadJson.media.public_id }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error('Imagem enviada, mas não foi possível definir a capa', { description: typeof json.error === 'string' ? json.error : undefined })
        return
      }
      toast.success('Capa atualizada!')
      await load()
    } catch {
      toast.error('Erro de rede ao enviar a capa')
    } finally {
      setBusyId(null)
    }
  }

  async function removeCover(category: CategoryRow) {
    if (!window.confirm(`Remover a capa de "${category.name}"? A home passará a usar a foto de um produto da categoria.`)) return
    setBusyId(category.id)
    try {
      const res = await fetch(`/api/configuracoes/atacado/categorias/${category.id}/capa`, { method: 'DELETE' })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        toast.error('Erro ao remover a capa', { description: typeof json.error === 'string' ? json.error : undefined })
        return
      }
      toast.success('Capa removida')
      await load()
    } finally {
      setBusyId(null)
    }
  }

  if (categories === null) return <p className="text-xs text-text-muted">Carregando categorias...</p>
  if (categories.length === 0) return <p className="text-xs text-text-muted italic">Nenhuma categoria cadastrada.</p>

  return (
    <div className="space-y-2">
      <input ref={inputRef} type="file" accept={ACCEPTED_MIME} className="hidden" onChange={handleFile} />
      {categories.map((c) => (
        <div key={c.id} className="flex items-center gap-3 p-2.5 rounded-lg border border-border bg-bg-overlay">
          <div className="relative w-12 h-16 rounded-md overflow-hidden bg-bg-card shrink-0 flex items-center justify-center">
            {c.cover ? <Image src={c.cover.url} alt={c.cover.alt ?? c.name} fill sizes="48px" className="object-cover" /> : <ImageOff className="w-4 h-4 text-text-muted" />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-text-primary truncate">{c.name}</p>
            <p className="text-xs text-text-muted">
              {c.cover ? 'Capa configurada' : 'Sem capa — a home usa a foto de um produto da categoria'}
              {!c.active && ' · inativa (não aparece no atacado)'}
            </p>
          </div>
          <Button type="button" variant="secondary" size="sm" loading={busyId === c.id} onClick={() => { targetRef.current = c.id; inputRef.current?.click() }}>
            <ImagePlus className="w-3.5 h-3.5" /> {c.cover ? 'Trocar' : 'Enviar capa'}
          </Button>
          {c.cover && (
            <button type="button" onClick={() => removeCover(c)} disabled={busyId === c.id} aria-label="Remover capa" className="p-1 text-text-muted hover:text-error disabled:opacity-40">
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      ))}
      <p className="text-[11px] text-text-muted">Proporção ideal: vertical 4:5 (ex.: 800×1000 px). WEBP, JPG ou PNG, até 5 MB.</p>
    </div>
  )
}
