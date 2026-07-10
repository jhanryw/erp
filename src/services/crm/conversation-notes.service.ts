/**
 * Service de CRM — Notas internas de conversa (crm_conversation_notes).
 *
 * Nota simples, sem edição/exclusão nesta entrega (Entrega 9) — só
 * criar/listar. `created_by` é sempre o usuário da sessão que chamou a API
 * (nunca automação) — é o mesmo campo que uma futura atribuição de
 * atendente (`crm_conversations.assigned_to`, fora de escopo aqui) vai
 * reaproveitar como padrão de autoria.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { CrmConversationNote } from '@/types/database.types'
import type { ServiceOutcome } from '../produtos.service'

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

export interface CreateConversationNoteInput {
  companyId: number
  conversationId: number
  content: string
  createdBy: string
}

export async function createConversationNote(
  input: CreateConversationNoteInput,
): Promise<ServiceOutcome<CrmConversationNote>> {
  const content = input.content.trim()
  if (!content) return failure('Conteúdo da nota é obrigatório.', 422)

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_conversation_notes')
    .insert({
      company_id: input.companyId,
      conversation_id: input.conversationId,
      content,
      created_by: input.createdBy,
    } as any)
    .select('*')
    .single() as unknown as { data: CrmConversationNote | null; error: { message: string } | null }

  if (error) return failure(error.message)
  return success(data!)
}

export interface ConversationNoteWithAuthor extends CrmConversationNote {
  createdByName: string | null
}

/**
 * Lista notas + nome de quem escreveu, resolvido em lote contra
 * `public.users` (1 query extra, nunca N+1 por nota) — sem isso o "criado
 * por" apareceria como UUID cru na UI.
 */
export async function listConversationNotes(
  conversationId: number,
  companyId: number,
): Promise<ServiceOutcome<ConversationNoteWithAuthor[]>> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('crm_conversation_notes')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false }) as unknown as {
      data: CrmConversationNote[] | null
      error: { message: string } | null
    }

  if (error) return failure(error.message)
  const notes = data ?? []
  if (notes.length === 0) return success([])

  const authorIds = [...new Set(notes.map((note) => note.created_by))]
  const { data: authors } = await admin
    .from('users')
    .select('id, name')
    .in('id', authorIds) as unknown as { data: Array<{ id: string; name: string | null }> | null }

  const nameById = new Map((authors ?? []).map((author) => [author.id, author.name]))

  return success(notes.map((note) => ({ ...note, createdByName: nameById.get(note.created_by) ?? null })))
}
