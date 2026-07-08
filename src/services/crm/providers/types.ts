/**
 * Contrato de provider de mensageria (Entrega 6).
 *
 * Um provider só sabe fazer 3 coisas: enviar, devolver resultado, traduzir
 * protocolo. Nenhuma regra de negócio (idempotência, ordem de status,
 * resolução de conversa/pessoa) vive aqui — isso é responsabilidade do
 * outbound-message.service.ts, que chama o provider como último passo.
 *
 * Trocar Evolution por outro canal no futuro = criar um novo arquivo
 * implementando esta interface + registrar em registry.ts. Nenhuma mudança
 * em outbound-message.service.ts ou na rota HTTP.
 */

import type { CrmChannel, CrmMessageContentType, Json } from '@/types/database.types'

export interface ProviderSendInput {
  /** Canal operacional completo (traz provider_instance_identifier, não só o tipo). */
  channel: CrmChannel
  /** Valor já normalizado da identidade do destinatário (telefone/handle/e-mail). */
  recipientIdentityValue: string
  content: string | null
  contentType: CrmMessageContentType
  /** URL já resolvida do Media Hub (signed ou pública) — nunca base64. */
  mediaUrl?: string | null
  mediaMimeType?: string | null
  metadata?: Json | null
  /** Repassado ao provider/N8N para correlação e defesa contra reenvio duplicado. */
  idempotencyKey: string
}

export interface ProviderSendResult {
  ok: boolean
  /** Vira crm_messages.external_message_id quando ok=true. */
  providerMessageId?: string | null
  errorMessage?: string | null
}

export interface MessageProvider {
  sendMessage(input: ProviderSendInput): Promise<ProviderSendResult>
}
