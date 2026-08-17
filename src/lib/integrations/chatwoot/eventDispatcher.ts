/**
 * Roteamento de eventos do webhook Chatwoot já verificado (assinatura +
 * tenant resolvidos) — Fase 3.
 *
 * Eventos fora de CHATWOOT_HANDLED_EVENTS (message_created/updated,
 * webwidget_triggered, inbox_*, conversation_status_changed, typing_*) são
 * deliberadamente ignorados aqui — a rota devolve 200 mesmo assim (seção 11
 * do pedido: evento conhecido mas não consumido nunca deve causar retry do
 * Chatwoot).
 */

import { resolveContactFromChatwoot } from './contactResolver'
import {
  CHATWOOT_HANDLED_EVENTS,
  ChatwootContactEventSchema,
  ChatwootConversationEventSchema,
  extractEmbeddedContact,
  extractEventName,
  type ChatwootHandledEvent,
} from './types'
import type { CompanyIntegration } from '@/services/integrations/company-integrations.service'

export interface DispatchResult {
  event: string
  handled: boolean
  outcome?: string
  reason?: string
}

function isHandledEvent(event: string | null): event is ChatwootHandledEvent {
  return !!event && (CHATWOOT_HANDLED_EVENTS as readonly string[]).includes(event)
}

export async function dispatchChatwootEvent(
  rawPayload: unknown,
  integration: CompanyIntegration,
): Promise<DispatchResult> {
  const eventName = extractEventName(rawPayload)

  if (!isHandledEvent(eventName)) {
    return { event: eventName ?? 'unknown', handled: false, reason: 'event_not_consumed_by_this_phase' }
  }

  if (eventName === 'contact_created' || eventName === 'contact_updated') {
    const parsed = ChatwootContactEventSchema.safeParse(rawPayload)
    if (!parsed.success) return { event: eventName, handled: false, reason: 'invalid_payload' }

    const result = await resolveContactFromChatwoot(integration.company_id, integration.id, {
      id: String(parsed.data.id),
      name: parsed.data.name,
      email: parsed.data.email,
      phone_number: parsed.data.phone_number,
    })

    if (!result.ok) return { event: eventName, handled: false, reason: 'resolution_failed' }
    return { event: eventName, handled: true, outcome: result.data.status }
  }

  // conversation_created / conversation_updated — nunca cria crm_conversation
  // nem external_entity_links pra conversa em si (decisão da Fase 3, ver
  // relatório seção I). Só serve como gatilho alternativo pra resolver o
  // contato embutido, cobrindo o caso de conversation_created chegar antes
  // de contact_created (seção 26 do pedido — ordem não é garantida).
  const parsed = ChatwootConversationEventSchema.safeParse(rawPayload)
  if (!parsed.success) return { event: eventName, handled: false, reason: 'invalid_payload' }

  const embeddedContact = extractEmbeddedContact(rawPayload)
  if (!embeddedContact) {
    return { event: eventName, handled: true, reason: 'no_embedded_contact_extractable' }
  }

  const result = await resolveContactFromChatwoot(integration.company_id, integration.id, embeddedContact)
  if (!result.ok) return { event: eventName, handled: false, reason: 'resolution_failed' }
  return { event: eventName, handled: true, outcome: result.data.status }
}
