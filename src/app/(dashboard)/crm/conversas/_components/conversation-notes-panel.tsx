'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { formatDateTime } from '@/lib/utils/date'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

// Espelha o contrato JSON de GET/POST /api/crm/conversations/[id]/notes.
interface ConversationNote {
  id: number
  content: string
  created_by: string
  created_by_name: string | null
  created_at: string
}

/**
 * Painel de notas internas (Entrega 9) — nunca visível pro cliente, só
 * carrega quando montado (o pai só monta isto quando o painel está
 * expandido), sem edição/exclusão nesta entrega.
 */
export function ConversationNotesPanel({ conversationId }: { conversationId: number }) {
  const [notes, setNotes] = useState<ConversationNote[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Falha de API nunca vira "lista vazia" silenciosa — antes desta correção
  // um erro de rede/backend aqui era indistinguível de "sem notas ainda".
  async function loadNotes() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/crm/conversations/${conversationId}/notes`)
      const json = await res.json()
      if (!res.ok) {
        setNotes([])
        setError(json.error ?? 'Erro ao carregar notas.')
        toast.error('Erro ao carregar notas', { description: json.error })
        return
      }
      setNotes(json.notes ?? [])
    } catch {
      setNotes([])
      setError('Erro de rede ao carregar notas.')
      toast.error('Erro de rede ao carregar notas')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadNotes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  async function handleAddNote() {
    const trimmed = content.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/crm/conversations/${conversationId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: trimmed }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error('Erro ao salvar nota', { description: json.error })
        return
      }
      setContent('')
      await loadNotes()
    } catch {
      toast.error('Erro de rede ao salvar nota')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="border-b border-border bg-bg-overlay/40 p-3 flex flex-col gap-2 max-h-[240px]">
      <div className="flex items-end gap-2">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Nota interna (não visível pro cliente)..."
          rows={2}
          disabled={submitting}
          className="flex-1 resize-none rounded-xl border border-border bg-bg-elevated px-3 py-2 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand disabled:opacity-60"
        />
        <Button type="button" size="sm" onClick={handleAddNote} disabled={!content.trim() || submitting} loading={submitting}>
          {!submitting && 'Adicionar'}
        </Button>
      </div>

      <div className="overflow-y-auto flex flex-col gap-1.5">
        {loading && (
          <div className="flex items-center justify-center py-3">
            <Spinner size="sm" />
          </div>
        )}

        {!loading && error && (
          <p className="text-xs text-error text-center py-2">{error}</p>
        )}

        {!loading && !error && notes.length === 0 && (
          <p className="text-xs text-text-muted text-center py-2">Nenhuma nota ainda.</p>
        )}

        {notes.map((note) => (
          <div key={note.id} className="text-xs bg-bg-elevated border border-border rounded-lg px-2.5 py-1.5">
            <p className="text-text-primary whitespace-pre-wrap break-words">{note.content}</p>
            <p className="text-text-muted mt-1">
              {note.created_by_name ?? 'Usuário'} · {formatDateTime(note.created_at)}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
