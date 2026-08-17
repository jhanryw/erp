/**
 * Types/schemas dos payloads de webhook do Chatwoot que o Qarvon realmente
 * consome nesta fase (Fase 3 — Chatwoot Inbound). Não é uma modelagem
 * completa da API do Chatwoot — só os campos usados, validados em runtime
 * via zod (já é dependência do projeto, reaproveitada, nenhuma nova).
 *
 * `.passthrough()` em todo objeto: payload do Chatwoot pode evoluir com
 * campos novos sem quebrar o parser (seção 35 do pedido da Fase 3).
 *
 * FONTES CONSULTADAS EM 2026-08-16 (ver relatório da Fase 3, seção A, para
 * citações completas):
 *   - https://developers.chatwoot.com/api-reference/webhooks/add-a-webhook
 *   - https://www.chatwoot.com/hc/user-guide/articles/1677693021-how-to-use-webhooks
 *   - app/models/webhook.rb (branch develop, chatwoot/chatwoot no GitHub) —
 *     ALLOWED_WEBHOOK_EVENTS
 *   - app/views/api/v1/models/_contact.json.jbuilder (branch develop) —
 *     campos reais de um contato serializado (confirma `phone_number`, não
 *     `phone`)
 *
 * INCERTEZA REGISTRADA (não resolvida só com documentação — precisa de
 * payload real capturado, seção 39 do pedido): a forma exata como um
 * evento `conversation_created`/`conversation_updated` embute os dados do
 * contato associado (`meta.sender` vs `contact_inbox.contact` vs outra
 * chave) não foi confirmada com certeza — `extractEmbeddedContact()` abaixo
 * tenta os caminhos mais prováveis de forma defensiva e retorna `null` se
 * nenhum bater, nunca inventa dado.
 */

import { z } from 'zod'

// ─── Lista completa de eventos permitidos pelo Chatwoot (ALLOWED_WEBHOOK_EVENTS) ──
// Confirmado via app/models/webhook.rb — usado só pra validar que o evento
// recebido é um que o Chatwoot de fato pode enviar (defesa contra payload
// malformado), não significa que processamos todos.
export const CHATWOOT_ALL_KNOWN_EVENTS = [
  'conversation_status_changed',
  'conversation_updated',
  'conversation_created',
  'contact_created',
  'contact_updated',
  'message_created',
  'message_updated',
  'webwidget_triggered',
  'inbox_created',
  'inbox_updated',
  'conversation_typing_on',
  'conversation_typing_off',
] as const

// Eventos que esta fase efetivamente processa — seção 11/12 do pedido:
// message_created/updated, webwidget_triggered, inbox_*, typing_* e
// conversation_status_changed são deliberadamente ignorados (200, nunca
// processados) — não replicamos mensagens, não usamos inbox como tenant.
export const CHATWOOT_HANDLED_EVENTS = [
  'contact_created',
  'contact_updated',
  'conversation_created',
  'conversation_updated',
] as const

export type ChatwootHandledEvent = (typeof CHATWOOT_HANDLED_EVENTS)[number]

// ─── Extração NÃO-CONFIÁVEL de account id (só pra selecionar o secret candidato) ──
// Usada ANTES da verificação de assinatura — nunca usar o valor retornado
// aqui pra decidir company_id definitivo (isso só acontece depois da
// assinatura validar, e com checagem de mismatch — seção 37 do pedido).
export function extractUnverifiedAccountId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

  if (obj.account && typeof obj.account === 'object') {
    const acc = obj.account as Record<string, unknown>
    if (acc.id != null) return String(acc.id)
  }
  if (obj.account_id != null) return String(obj.account_id)

  return null
}

export function extractEventName(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  return typeof obj.event === 'string' ? obj.event : null
}

// ─── Schemas dos eventos processados ────────────────────────────────────────

export const ChatwootContactEventSchema = z
  .object({
    event: z.enum(['contact_created', 'contact_updated']),
    id: z.union([z.number(), z.string()]),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    phone_number: z.string().nullable().optional(),
  })
  .passthrough()

export type ChatwootContactEvent = z.infer<typeof ChatwootContactEventSchema>

export const ChatwootConversationEventSchema = z
  .object({
    event: z.enum(['conversation_created', 'conversation_updated']),
    id: z.union([z.number(), z.string()]),
  })
  .passthrough()

export type ChatwootConversationEvent = z.infer<typeof ChatwootConversationEventSchema>

export interface EmbeddedContact {
  id: string
  name?: string | null
  email?: string | null
  phone_number?: string | null
}

/**
 * Tenta extrair o contato embutido num payload de conversa. Caminhos
 * tentados, em ordem (nenhum confirmado com 100% de certeza — ver nota de
 * incerteza no cabeçalho do arquivo): `meta.sender`, `contact_inbox.contact`,
 * `contact` (top-level). Retorna `null` se nenhum caminho tiver um `id`
 * utilizável — nunca inventa/adivinha.
 */
export function extractEmbeddedContact(raw: unknown): EmbeddedContact | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

  const candidates: unknown[] = [
    (obj.meta as Record<string, unknown> | undefined)?.sender,
    (obj.contact_inbox as Record<string, unknown> | undefined)?.contact,
    obj.contact,
  ]

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      const c = candidate as Record<string, unknown>
      if (c.id != null) {
        return {
          id: String(c.id),
          name: typeof c.name === 'string' ? c.name : null,
          email: typeof c.email === 'string' ? c.email : null,
          phone_number: typeof c.phone_number === 'string' ? c.phone_number : null,
        }
      }
    }
  }

  return null
}
