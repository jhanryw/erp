'use client'

import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { safeLinkUrl, type LinkItem } from '@/services/wholesale/siteChrome'

/** Lista ordenável de links (texto + URL http(s)/relativa). A ordem aqui é a ordem no site. */
export function LinkListEditor({ label, links, max, onChange }: { label: string; links: LinkItem[]; max: number; onChange: (links: LinkItem[]) => void }) {
  const set = (i: number, patch: Partial<LinkItem>) => onChange(links.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= links.length) return
    const next = [...links]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-text-primary">{label}</p>
      {links.length === 0 && <p className="text-xs italic text-text-muted">Nenhum link adicional.</p>}
      {links.map((link, i) => {
        const invalid = link.url.trim() !== '' && safeLinkUrl(link.url) === null
        return (
          <div key={i} className="space-y-1">
            <div className="flex items-center gap-1.5">
              <input aria-label={`${label}: texto do link ${i + 1}`} className="input-base w-1/3" maxLength={40} placeholder="Texto" value={link.label} onChange={(e) => set(i, { label: e.target.value })} />
              <input aria-label={`${label}: endereço do link ${i + 1}`} className={`input-base flex-1 ${invalid ? 'border-error' : ''}`} placeholder="https://… ou /caminho" value={link.url} onChange={(e) => set(i, { url: e.target.value })} />
              <button type="button" aria-label="Subir" disabled={i === 0} onClick={() => move(i, -1)} className="p-1 text-text-muted hover:text-text-primary disabled:opacity-30"><ChevronUp className="h-4 w-4" /></button>
              <button type="button" aria-label="Descer" disabled={i === links.length - 1} onClick={() => move(i, 1)} className="p-1 text-text-muted hover:text-text-primary disabled:opacity-30"><ChevronDown className="h-4 w-4" /></button>
              <button type="button" aria-label="Remover link" onClick={() => onChange(links.filter((_, idx) => idx !== i))} className="p-1 text-text-muted hover:text-error"><Trash2 className="h-4 w-4" /></button>
            </div>
            {invalid && <p className="text-[11px] text-error">Use um link http(s):// ou um caminho iniciado por /. Outros esquemas (javascript:, data:) são recusados.</p>}
          </div>
        )
      })}
      {links.length < max && (
        <Button type="button" size="sm" variant="secondary" onClick={() => onChange([...links, { label: '', url: '' }])}>
          <Plus className="h-3.5 w-3.5" /> Adicionar link
        </Button>
      )}
    </div>
  )
}
