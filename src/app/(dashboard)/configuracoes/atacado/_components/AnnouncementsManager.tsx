'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HEX_COLOR, MIN_ANNOUNCEMENT_CONTRAST, contrastRatio } from '@/services/wholesale/siteChrome'

interface Announcement { id: number; message: string; linkUrl: string | null; backgroundColor: string; textColor: string; isActive: boolean }
interface Draft { message: string; linkUrl: string; backgroundColor: string; textColor: string; isActive: boolean }

const EMPTY: Draft = { message: '', linkUrl: '', backgroundColor: '#A71818', textColor: '#FFFFFF', isActive: true }

function Preview({ draft }: { draft: Draft }) {
  const ok = HEX_COLOR.test(draft.backgroundColor) && HEX_COLOR.test(draft.textColor)
  const ratio = ok ? contrastRatio(draft.backgroundColor, draft.textColor) : 0
  return (
    <div className="space-y-1">
      <div className="flex h-9 items-center justify-center rounded-md px-3 text-center text-sm" style={{ backgroundColor: ok ? draft.backgroundColor : '#A71818', color: ok ? draft.textColor : '#fff' }}>
        <span className="line-clamp-1">{draft.message || 'Prévia da mensagem'}</span>
      </div>
      <p className={`text-[11px] ${ratio >= MIN_ANNOUNCEMENT_CONTRAST ? 'text-text-muted' : 'text-error'}`}>
        Contraste {ratio ? ratio.toFixed(1) : '—'}:1 {ratio >= MIN_ANNOUNCEMENT_CONTRAST ? '(legível)' : `— mínimo ${MIN_ANNOUNCEMENT_CONTRAST}:1; o servidor recusa abaixo disso`}
      </p>
    </div>
  )
}

function Form({ draft, onChange, onSubmit, onCancel, busy, submitLabel }: { draft: Draft; onChange: (d: Draft) => void; onSubmit: () => void; onCancel?: () => void; busy: boolean; submitLabel: string }) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-bg-overlay p-3">
      <label className="block space-y-1 text-xs text-text-muted">
        Mensagem (até 160 caracteres)
        <input className="input-base w-full" maxLength={160} value={draft.message} onChange={(e) => onChange({ ...draft, message: e.target.value })} placeholder="Ex.: Enviamos para todo o Brasil" />
      </label>
      <label className="block space-y-1 text-xs text-text-muted">
        Link (opcional — https://… ou /caminho)
        <input className="input-base w-full" maxLength={500} value={draft.linkUrl} onChange={(e) => onChange({ ...draft, linkUrl: e.target.value })} />
      </label>
      <div className="flex flex-wrap items-center gap-4 text-xs text-text-muted">
        <label className="flex items-center gap-2">Fundo <input type="color" value={HEX_COLOR.test(draft.backgroundColor) ? draft.backgroundColor : '#A71818'} onChange={(e) => onChange({ ...draft, backgroundColor: e.target.value.toUpperCase() })} /></label>
        <label className="flex items-center gap-2">Texto <input type="color" value={HEX_COLOR.test(draft.textColor) ? draft.textColor : '#FFFFFF'} onChange={(e) => onChange({ ...draft, textColor: e.target.value.toUpperCase() })} /></label>
        <label className="flex items-center gap-2"><input type="checkbox" className="accent-brand" checked={draft.isActive} onChange={(e) => onChange({ ...draft, isActive: e.target.checked })} /> Ativa</label>
      </div>
      <Preview draft={draft} />
      <div className="flex gap-2">
        <Button size="sm" loading={busy} disabled={draft.message.trim() === ''} onClick={onSubmit}>{submitLabel}</Button>
        {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancelar</Button>}
      </div>
    </div>
  )
}

const toDraft = (a: Announcement): Draft => ({ message: a.message, linkUrl: a.linkUrl ?? '', backgroundColor: a.backgroundColor, textColor: a.textColor, isActive: a.isActive })

export function AnnouncementsManager({ intervalSeconds, onIntervalChange }: { intervalSeconds: number; onIntervalChange: (seconds: number) => void }) {
  const [items, setItems] = useState<Announcement[] | null>(null)
  const [pending, setPending] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY)
  const [newDraft, setNewDraft] = useState<Draft>(EMPTY)

  const load = useCallback(async () => {
    const res = await fetch('/api/configuracoes/atacado/anuncios')
    const json = await res.json()
    if (!res.ok) { toast.error('Não foi possível carregar os anúncios', { description: json.error }); setItems([]); return }
    setItems(json.announcements)
    setPending(!!json.migrationPending)
  }, [])
  useEffect(() => { void load() }, [load])

  async function call(url: string, method: string, body: unknown | null, ok: string): Promise<boolean> {
    setBusy(true)
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error('Não foi possível salvar', { description: typeof json.error === 'string' ? json.error : undefined }); return false }
      toast.success(ok)
      await load()
      return true
    } finally { setBusy(false) }
  }

  const payload = (d: Draft) => ({ message: d.message, linkUrl: d.linkUrl.trim() === '' ? null : d.linkUrl, backgroundColor: d.backgroundColor, textColor: d.textColor, isActive: d.isActive })

  async function move(index: number, delta: -1 | 1) {
    if (!items) return
    const j = index + delta
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[index], next[j]] = [next[j], next[index]]
    setItems(next)
    await call('/api/configuracoes/atacado/anuncios/reorder', 'POST', { ids: next.map((a) => a.id) }, 'Ordem atualizada')
  }

  if (items === null) return <p className="text-sm text-text-muted">Carregando...</p>
  if (pending) return <p className="text-sm text-text-primary">A barra de anúncios ainda não está disponível neste banco: a migration <code>202610141000_wholesale_site_chrome</code> não foi aplicada. O site funciona normalmente sem a barra.</p>

  return (
    <div className="space-y-4">
      <label className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        Trocar de mensagem a cada
        <input type="number" min={3} max={30} value={intervalSeconds} onChange={(e) => onIntervalChange(Math.min(30, Math.max(3, Number(e.target.value) || 5)))} className="input-base w-20" />
        segundos (entre 3 e 30; vale ao clicar em “Salvar configuração”). A troca pausa ao passar o mouse/focar e é desligada para quem prefere menos movimento.
      </label>

      {items.length === 0 && <p className="text-xs italic text-text-muted">Nenhuma mensagem. Sem mensagens ativas a barra não aparece no site.</p>}

      {items.map((a, i) => (
        <div key={a.id} className="space-y-2">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-card p-2.5">
            <span className="h-6 w-6 shrink-0 rounded" style={{ backgroundColor: a.backgroundColor }} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-text-primary">{a.message}</p>
              <p className="truncate text-[11px] text-text-muted">{a.linkUrl ?? 'Sem link'}{!a.isActive && ' · inativa'}</p>
            </div>
            <label className="flex shrink-0 items-center gap-1.5 text-xs">
              <input type="checkbox" className="accent-brand" checked={a.isActive} onChange={() => call(`/api/configuracoes/atacado/anuncios/${a.id}`, 'PATCH', { isActive: !a.isActive }, 'Atualizado')} /> Ativa
            </label>
            <button type="button" aria-label="Subir" disabled={i === 0 || busy} onClick={() => move(i, -1)} className="p-1 text-text-muted disabled:opacity-30"><ChevronUp className="h-4 w-4" /></button>
            <button type="button" aria-label="Descer" disabled={i === items.length - 1 || busy} onClick={() => move(i, 1)} className="p-1 text-text-muted disabled:opacity-30"><ChevronDown className="h-4 w-4" /></button>
            <button type="button" aria-label={`Editar anúncio ${a.message}`} onClick={() => { setEditingId(editingId === a.id ? null : a.id); setEditDraft(toDraft(a)) }} className="p-1 text-text-muted hover:text-text-primary"><Pencil className="h-4 w-4" /></button>
            <button type="button" aria-label={`Excluir anúncio ${a.message}`} onClick={() => { if (window.confirm('Excluir este anúncio?')) void call(`/api/configuracoes/atacado/anuncios/${a.id}`, 'DELETE', null, 'Anúncio excluído') }} className="p-1 text-text-muted hover:text-error"><Trash2 className="h-4 w-4" /></button>
          </div>
          {editingId === a.id && (
            <Form draft={editDraft} onChange={setEditDraft} busy={busy} submitLabel="Salvar anúncio" onCancel={() => setEditingId(null)}
              onSubmit={async () => { if (await call(`/api/configuracoes/atacado/anuncios/${a.id}`, 'PATCH', payload(editDraft), 'Anúncio salvo')) setEditingId(null) }} />
          )}
        </div>
      ))}

      <div>
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-primary"><Plus className="h-3.5 w-3.5" /> Nova mensagem</p>
        <Form draft={newDraft} onChange={setNewDraft} busy={busy} submitLabel="Adicionar mensagem"
          onSubmit={async () => { if (await call('/api/configuracoes/atacado/anuncios', 'POST', payload(newDraft), 'Mensagem adicionada')) setNewDraft(EMPTY) }} />
      </div>
    </div>
  )
}
