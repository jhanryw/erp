/**
 * Provider Evolution (WhatsApp) — Entrega 6.
 *
 * NÃO chama a API do Evolution. Chama um webhook do N8N (síncrono, ERP
 * aguarda a resposta) — o N8N é quem fala com o Evolution de verdade, mesma
 * disciplina já usada em todo o resto da Fase 3 (Entregas 3-5: N8N é o
 * único que conhece o Evolution, credencial nunca sai do cofre dele).
 *
 * Isso é o que permite trocar Evolution por outro provider (Meta Cloud API,
 * Telegram Bot API, SMTP) sem tocar em outbound-message.service.ts nem na
 * rota — só criar um novo arquivo implementando MessageProvider.
 */

import type { MessageProvider, ProviderSendInput, ProviderSendResult } from './types'

const SEND_TIMEOUT_MS = 20_000

interface N8nOutboundResponse {
  ok?: boolean
  provider_message_id?: string
  error?: string
}

export class EvolutionProvider implements MessageProvider {
  async sendMessage(input: ProviderSendInput): Promise<ProviderSendResult> {
    const url = process.env.N8N_CRM_OUTBOUND_WEBHOOK_URL
    const secret = process.env.N8N_CRM_OUTBOUND_SECRET

    if (!url || !secret) {
      return { ok: false, errorMessage: 'N8N_CRM_OUTBOUND_WEBHOOK_URL/N8N_CRM_OUTBOUND_SECRET não configurados.' }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          provider_instance_identifier: input.channel.provider_instance_identifier,
          recipient_identity_value: input.recipientIdentityValue,
          content: input.content,
          content_type: input.contentType,
          media_url: input.mediaUrl ?? null,
          media_mime_type: input.mediaMimeType ?? null,
          metadata: input.metadata ?? null,
          idempotency_key: input.idempotencyKey,
        }),
        signal: controller.signal,
      })

      let body: N8nOutboundResponse | null = null
      try {
        body = await response.json() as N8nOutboundResponse
      } catch {
        body = null
      }

      if (!response.ok || !body?.ok) {
        return { ok: false, errorMessage: body?.error ?? `N8N respondeu HTTP ${response.status}.` }
      }

      if (!body.provider_message_id) {
        return { ok: false, errorMessage: 'N8N respondeu ok=true sem provider_message_id.' }
      }

      return { ok: true, providerMessageId: body.provider_message_id }
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError'
      const message = isAbort
        ? `Timeout (${SEND_TIMEOUT_MS}ms) ao aguardar resposta do N8N.`
        : (err instanceof Error ? err.message : 'Erro desconhecido ao chamar N8N.')
      return { ok: false, errorMessage: message }
    } finally {
      clearTimeout(timeout)
    }
  }
}
