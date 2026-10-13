'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ArrowLeft, Palette, Pencil, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

interface Member { productId: number; name: string; active?: boolean; wholesaleEnabled?: boolean }
interface Group { id: number; name: string; members: Member[] }
interface Product { id: number; name: string }
interface Suggestion { baseName: string; products: Product[] }
interface Payload { groups: Group[]; ungrouped: Product[]; suggestions: Suggestion[]; migrationPending?: boolean }

/** Seletor com busca sobre produtos SEM grupo (um produto só pode estar em um grupo). */
function ProductPicker({ products, picked, onToggle, placeholder }: { products: Product[]; picked: number[]; onToggle: (id: number, on: boolean) => void; placeholder: string }) {
  const [filter, setFilter] = useState('')
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return products.filter((p) => !needle || p.name.toLowerCase().includes(needle))
  }, [products, filter])

  return (
    <div className="space-y-2">
      <input className="input-base w-full" placeholder={placeholder} value={filter} onChange={(e) => setFilter(e.target.value)} />
      <ul className="max-h-56 overflow-y-auto divide-y divide-border rounded-lg border border-border">
        {visible.map((p) => (
          <li key={p.id}>
            <label className="flex items-center gap-2.5 px-3 py-2 text-sm text-text-primary cursor-pointer">
              <input type="checkbox" className="accent-brand" checked={picked.includes(p.id)} onChange={(e) => onToggle(p.id, e.target.checked)} />
              {p.name}
            </label>
          </li>
        ))}
        {visible.length === 0 && <li className="px-3 py-2 text-xs text-text-muted">Nenhum produto sem grupo encontrado.</li>}
      </ul>
    </div>
  )
}

function GroupEditor({ group, ungrouped, busy, onSave, onCancel }: {
  group: Group; ungrouped: Product[]; busy: boolean
  onSave: (patch: { name: string; productIds: number[] }) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(group.name)
  const [members, setMembers] = useState<Member[]>(group.members)
  const [adding, setAdding] = useState<number[]>([])
  const toAdd = ungrouped.filter((p) => adding.includes(p.id))
  const finalIds = [...members.map((m) => m.productId), ...toAdd.map((p) => p.id)]

  return (
    <div className="mt-3 space-y-3 rounded-lg bg-bg-overlay p-3">
      <label className="block space-y-1 text-xs text-text-muted">
        Nome interno do grupo
        <input className="input-base w-full" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </label>

      <div className="space-y-1">
        <p className="text-xs font-medium text-text-primary">Produtos do grupo ({finalIds.length})</p>
        <ul className="space-y-1">
          {members.map((m) => (
            <li key={m.productId} className="flex items-center justify-between gap-2 rounded-md border border-border bg-bg-card px-2.5 py-1.5 text-sm text-text-primary">
              <span className="truncate">
                {m.name}
                {m.active === false && <span className="ml-2 text-xs text-text-muted">(inativo)</span>}
                {m.wholesaleEnabled === false && <span className="ml-2 text-xs text-text-muted">(fora do atacado)</span>}
              </span>
              <button type="button" aria-label={`Remover ${m.name} do grupo`} onClick={() => setMembers((prev) => prev.filter((x) => x.productId !== m.productId))} className="p-1 text-text-muted hover:text-error">
                <X className="w-4 h-4" />
              </button>
            </li>
          ))}
          {members.length === 0 && <li className="text-xs text-text-muted">Nenhum produto restante.</li>}
        </ul>
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium text-text-primary">Adicionar produtos</p>
        <ProductPicker
          products={ungrouped} picked={adding} placeholder="Pesquisar produtos sem grupo..."
          onToggle={(id, on) => setAdding((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)))}
        />
      </div>

      {finalIds.length < 2 && <p className="text-xs text-amber-700">Com menos de 2 produtos o grupo não tem efeito no site.</p>}

      <div className="flex gap-2">
        <Button size="sm" disabled={busy || finalIds.length < 1 || name.trim().length === 0} onClick={() => onSave({ name: name.trim(), productIds: finalIds })}>
          Salvar grupo
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancelar</Button>
      </div>
    </div>
  )
}

export function ColorGroupsManager() {
  const [data, setData] = useState<Payload | null>(null)
  const [picked, setPicked] = useState<number[]>([])
  const [name, setName] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch('/api/configuracoes/atacado/cores')
    const json = await res.json()
    if (!res.ok) { toast.error('Não foi possível carregar', { description: json.error }); return }
    setData(json)
  }, [])
  useEffect(() => { void load() }, [load])

  async function call(url: string, init: RequestInit, okMessage: string, errorTitle: string) {
    setBusy(true)
    try {
      const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(errorTitle, { description: typeof json.error === 'string' ? json.error : undefined }); return false }
      toast.success(okMessage)
      await load()
      return true
    } finally { setBusy(false) }
  }

  async function create(groupName: string, productIds: number[]) {
    const ok = await call('/api/configuracoes/atacado/cores', { method: 'POST', body: JSON.stringify({ name: groupName, productIds }) }, 'Grupo criado', 'Erro ao criar o grupo')
    if (ok) { setPicked([]); setName('') }
  }

  async function save(group: Group, patch: { name: string; productIds: number[] }) {
    const ok = await call(`/api/configuracoes/atacado/cores/${group.id}`, { method: 'PATCH', body: JSON.stringify(patch) }, 'Grupo atualizado', 'Erro ao atualizar o grupo')
    if (ok) setEditingId(null)
  }

  async function remove(group: Group) {
    if (!window.confirm(`Desfazer o grupo "${group.name}"? Os produtos continuam existindo e aparecendo na vitrine; só deixam de ser cores um do outro.`)) return
    await call(`/api/configuracoes/atacado/cores/${group.id}`, { method: 'DELETE' }, 'Grupo desfeito', 'Erro ao desfazer o grupo')
  }

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/configuracoes/atacado"><Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div className="flex items-center gap-2">
          <Palette className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Cores do mesmo modelo</h2>
            <p className="text-sm text-text-muted">
              Os produtos continuam aparecendo individualmente na vitrine. O grupo só interliga as cores na página de detalhes.
            </p>
          </div>
        </div>
      </div>

      {data === null && <p className="text-sm text-text-muted">Carregando...</p>}

      {data?.migrationPending && (
        <Card className="p-5 text-sm text-text-primary">
          O agrupamento de cores ainda não está disponível neste banco: a migration <code>202610091300_product_color_groups</code> não foi aplicada.
          O site funciona normalmente; nenhuma cor é interligada até a migration ser aplicada.
        </Card>
      )}

      {data && !data.migrationPending && data.suggestions.length > 0 && (
        <Card className="p-5 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Sugestões para revisar</h3>
            <p className="text-xs text-text-muted">Nada é agrupado sozinho — confira antes de aceitar.</p>
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

      {data && !data.migrationPending && (
        <Card className="p-5 space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">Criar grupo</h3>
          <input className="input-base w-full" placeholder="Nome interno (ex.: Invisible Low)" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          <ProductPicker
            products={data.ungrouped} picked={picked} placeholder="Pesquisar produtos sem grupo..."
            onToggle={(id, on) => setPicked((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)))}
          />
          <Button disabled={busy || picked.length < 2 || name.trim().length === 0} onClick={() => create(name.trim(), picked)}>
            Criar grupo com {picked.length} produto{picked.length === 1 ? '' : 's'}
          </Button>
        </Card>
      )}

      {data && !data.migrationPending && (
        <Card className="p-5 space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">Grupos existentes ({data.groups.length})</h3>
          {data.groups.length === 0 && <p className="text-xs text-text-muted italic">Nenhum grupo ainda.</p>}
          {data.groups.map((g) => (
            <div key={g.id} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-text-primary">{g.name} <span className="text-xs font-normal text-text-muted">· {g.members.length} produto{g.members.length === 1 ? '' : 's'}</span></p>
                <div className="flex items-center gap-1">
                  <button type="button" aria-label={`Editar grupo ${g.name}`} onClick={() => setEditingId(editingId === g.id ? null : g.id)} className="p-1 text-text-muted hover:text-text-primary">
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button type="button" aria-label={`Desfazer grupo ${g.name}`} onClick={() => remove(g)} className="p-1 text-text-muted hover:text-error">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <p className="mt-1 text-xs text-text-muted">{g.members.map((m) => m.name).join(' · ')}</p>
              {editingId === g.id && (
                <GroupEditor key={`${g.id}-${g.members.length}`} group={g} ungrouped={data.ungrouped} busy={busy} onSave={(patch) => save(g, patch)} onCancel={() => setEditingId(null)} />
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}
