'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Tag, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

type Category = { id: number; name: string }

export default function ConfigCategoriasPage() {
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading]       = useState(true)
  const [newName, setNewName]       = useState('')
  const [saving, setSaving]         = useState(false)
  const [deleting, setDeleting]     = useState<Record<number, boolean>>({})

  async function load() {
    setLoading(true)
    const res  = await fetch('/api/categorias')
    const json = await res.json()
    setCategories(json.categories ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function add() {
    const name = newName.trim()
    if (!name) return
    setSaving(true)
    const res  = await fetch('/api/categorias', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const json = await res.json()
    setSaving(false)
    if (!res.ok) { toast.error('Erro ao adicionar', { description: json.error }); return }
    toast.success(`"${name}" adicionada!`)
    setNewName('')
    load()
  }

  async function remove(id: number, name: string) {
    if (!confirm(`Remover categoria "${name}"?`)) return
    setDeleting(p => ({ ...p, [id]: true }))
    const res  = await fetch(`/api/categorias?id=${id}`, { method: 'DELETE' })
    const json = await res.json()
    setDeleting(p => ({ ...p, [id]: false }))
    if (!res.ok) { toast.error('Erro ao remover', { description: json.error }); return }
    toast.success(`"${name}" removida`)
    load()
  }

  if (loading) return <div className="flex items-center justify-center py-16"><p className="text-sm text-text-muted">Carregando...</p></div>

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/configuracoes"><Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div className="flex items-center gap-2">
          <Tag className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Categorias</h2>
            <p className="text-sm text-text-muted">Categorias de produtos</p>
          </div>
        </div>
      </div>

      <div className="card p-6 space-y-4">
        <div className="flex flex-wrap gap-2 min-h-[36px]">
          {categories.length === 0
            ? <p className="text-sm text-text-muted italic">Nenhuma categoria cadastrada</p>
            : categories.map(c => (
              <div key={c.id} className="group flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-bg-overlay border border-border text-sm font-medium text-text-primary hover:border-error/50 transition-all">
                <span>{c.name}</span>
                <button onClick={() => remove(c.id, c.name)} disabled={deleting[c.id]} className="opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-error ml-0.5">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))
          }
        </div>

        <div className="flex gap-2 pt-1">
          <input
            type="text"
            className="input-base flex-1 text-sm"
            placeholder="Nova categoria... (ex: Conjuntos, Blusas)"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), add())}
          />
          <Button type="button" size="sm" onClick={add} loading={saving} disabled={!newName.trim()}>
            <Plus className="w-4 h-4" /> Adicionar
          </Button>
        </div>
        <p className="text-xs text-text-muted">Pressione <kbd className="px-1.5 py-0.5 rounded bg-bg-overlay border border-border font-mono text-xs">Enter</kbd> para adicionar rapidamente</p>
      </div>
    </div>
  )
}
