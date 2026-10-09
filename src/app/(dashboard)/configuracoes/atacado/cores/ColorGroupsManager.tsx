'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ArrowLeft, Palette, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

interface Member { productId: number; name: string }
interface Group { id: number; name: string; members: Member[] }
interface Product { id: number; name: string }
interface Suggestion { baseName: string; products: Product[] }
interface Payload { groups: Group[]; ungrouped: Product[]; suggestions: Suggestion[] }

export function ColorGroupsManager() {
  const [data, setData] = useState<Payload | null>(null)
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState<number[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch('/api/configuracoes/atacado/cores')
    const json = await res.json()
    if (!res.ok) { toast.error('Não foi possível carregar', { description: json.error }); return }
    setData(json)
  }, [])
  useEffect(() => { void load() }, [load])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return (data?.ungrouped ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle))
  }, [data, filter])

  async function create(groupName: string, productIds: number[]) {
    setBusy(true)
    try {
      const res = await fetch('/api/configuracoes/atacado/cores', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: groupName, productIds }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error('Erro ao criar o grupo', { description: typeof json.error === 'string' ? json.error : undefined }); return }
      toast.success('Grupo criado')
      setPicked([]); setName('')
      await load()
    } finally { setBusy(false) }
  }

  async function remove(group: Group) {
    if (!window.confirm(`Desfazer o grupo "${group.name}"? Os produtos continuam existindo, só deixam de aparecer como cores um do outro.`)) return
    setBusy(true)
    try {
      const res = await fetch(`/api/configuracoes/atacado/cores/${group.id}`, { method: 'DELETE' })
      if (!res.ok) { toast.error('Erro ao desfazer o grupo'); return }
      toast.success('Grupo desfeito')
      await load()
    } finally { setBusy(false) }
  }

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/configuracoes/atacado"><Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div className="flex items-center gap-2">
          <Palette className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Cores do mesmo modelo</h2>
            <p className="text-sm text-text-muted">Agrupe os produtos que são cores do mesmo modelo. No site, o cliente alterna entre as cores na página do produto.</p>
          </div>
        </div>
      </div>

      {data === null && <p className="text-sm text-text-muted">Carregando...</p>}

      {data && data.suggestions.length > 0 && (
        <Card className="p-5 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Sugestões para revisar</h3>
            <p className="text-xs text-text-muted">Produtos com o mesmo nome-base e uma cor cada. Nada é agrupado sozinho — confira antes de aceitar.</p>
          </div>
          {data.suggestions.map((s) => (
            <div key={s.baseName} className="rounded-lg border border-border p-3 space-y-2">
              <p className="text-sm font-medium text-text-primary">{s.baseName}</p>
              <p className="text-xs text-text-muted">{s.products.map((p) => p.name).join(' · ')}</p>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => create(s.baseName, s.products.map((p) => p.id))}>
                Agrupar estes {s.products.length}
              </Button>
            </div>
          ))}
        </Card>
      )}

      {data && (
        <Card className="p-5 space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">Criar grupo manualmente</h3>
          <input className="input-base w-full" placeholder="Nome do modelo (ex.: Calcinha Invisible Low Fio)" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          <input className="input-base w-full" placeholder="Filtrar produtos sem grupo..." value={filter} onChange={(e) => setFilter(e.target.value)} />
          <ul className="max-h-64 overflow-y-auto divide-y divide-border rounded-lg border border-border">
            {visible.map((p) => (
              <li key={p.id}>
                <label className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-primary cursor-pointer">
                  <input type="checkbox" className="accent-brand" checked={picked.includes(p.id)}
                    onChange={(e) => setPicked((prev) => (e.target.checked ? [...prev, p.id] : prev.filter((id) => id !== p.id)))} />
                  {p.name}
                </label>
              </li>
            ))}
            {visible.length === 0 && <li className="px-3 py-2 text-xs text-text-muted">Nenhum produto sem grupo encontrado.</li>}
          </ul>
          <Button disabled={busy || picked.length < 2 || name.trim().length === 0} onClick={() => create(name.trim(), picked)}>
            Criar grupo com {picked.length} produto{picked.length === 1 ? '' : 's'}
          </Button>
        </Card>
      )}

      {data && (
        <Card className="p-5 space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">Grupos existentes ({data.groups.length})</h3>
          {data.groups.length === 0 && <p className="text-xs text-text-muted italic">Nenhum grupo ainda.</p>}
          {data.groups.map((g) => (
            <div key={g.id} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-text-primary">{g.name}</p>
                <button type="button" aria-label={`Desfazer grupo ${g.name}`} onClick={() => remove(g)} className="p-1 text-text-muted hover:text-error">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <p className="mt-1 text-xs text-text-muted">{g.members.map((m) => m.name).join(' · ')}</p>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}
