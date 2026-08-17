/**
 * Verificação de assinatura de webhook do Chatwoot (Fase 3 — Chatwoot Inbound).
 *
 * Mecanismo confirmado na documentação oficial em 2026-08-16 (ver relatório
 * da Fase 3, seção A, para as URLs exatas consultadas e citações):
 *   - Headers: `X-Chatwoot-Signature` (`sha256=<hex>`), `X-Chatwoot-Timestamp`
 *     (unix seconds), `X-Chatwoot-Delivery` (id, quando disponível — só pra
 *     log/observabilidade, nunca usado como chave de idempotência aqui).
 *   - Assinatura: `sha256=` + HMAC-SHA256(secret, `${timestamp}.${rawBody}`).
 *   - Verificação exige o corpo BRUTO (nunca re-serializado — reordenar
 *     chaves ou mudar espaçamento muda o hash).
 *
 * ACHADO CRÍTICO DA PESQUISA (registrar pra quem for configurar a
 * integração real): Chatwoot GitHub issue #13809 (aberta 2026-03-14, ainda
 * aberta) documenta que o campo `secret` devolvido pela REST API ao
 * criar/consultar um webhook pode NÃO bater com o `hmac_token` interno
 * realmente usado pra assinar — ou seja, copiar "secret" da API/UI do
 * Chatwoot pode resultar em verificação sempre falhando aqui, mesmo com
 * tudo implementado corretamente. Mitigação: o checklist de ativação
 * (relatório da Fase 3, seção M/N) exige testar com um webhook REAL antes
 * de considerar a integração functional, nunca assumir que o secret
 * copiado da tela funciona.
 *
 * Janela de replay: a documentação consultada não define uma janela oficial
 * — ±5 minutos (seção 6 do pedido da Fase 3) foi adotado como valor
 * conservador nosso, não uma exigência documentada do Chatwoot. Se a
 * integração real apresentar webhooks legitimamente fora dessa janela
 * (relógio do servidor Chatwoot dessincronizado, fila de entrega
 * atrasada), ajustar aqui — está isolado numa única constante.
 */

import { createHmac, timingSafeEqual } from 'crypto'

export const CHATWOOT_REPLAY_WINDOW_SECONDS = 300 // ±5min — valor nosso, não documentado oficialmente (ver cabeçalho)

export type ChatwootSignatureFailureReason =
  | 'missing_headers'
  | 'invalid_timestamp'
  | 'timestamp_out_of_window'
  | 'signature_mismatch'

export type VerifyChatwootSignatureResult =
  | { ok: true }
  | { ok: false; reason: ChatwootSignatureFailureReason }

export function verifyChatwootWebhookSignature(params: {
  rawBody: string
  timestampHeader: string | null
  signatureHeader: string | null
  secret: string
  /** Injetável só pra teste — default é o relógio real. */
  nowSeconds?: number
}): VerifyChatwootSignatureResult {
  const { rawBody, timestampHeader, signatureHeader, secret } = params

  if (!timestampHeader || !signatureHeader) {
    return { ok: false, reason: 'missing_headers' }
  }

  const timestamp = Number(timestampHeader)
  if (!Number.isFinite(timestamp) || timestamp <= 0 || !/^\d+$/.test(timestampHeader)) {
    return { ok: false, reason: 'invalid_timestamp' }
  }

  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestamp) > CHATWOOT_REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_window' }
  }

  const expectedSignature = `sha256=${createHmac('sha256', secret).update(`${timestampHeader}.${rawBody}`, 'utf8').digest('hex')}`

  const expectedBuf = Buffer.from(expectedSignature, 'utf8')
  const receivedBuf = Buffer.from(signatureHeader, 'utf8')

  // timingSafeEqual exige buffers do mesmo tamanho — comparar o tamanho
  // primeiro não vaza informação útil (o tamanho de "sha256=<64 hex>" é
  // sempre fixo pra assinatura válida; um tamanho diferente já é inválido
  // por construção, não precisa de comparação constant-time pra isso).
  if (expectedBuf.length !== receivedBuf.length) {
    return { ok: false, reason: 'signature_mismatch' }
  }
  if (!timingSafeEqual(expectedBuf, receivedBuf)) {
    return { ok: false, reason: 'signature_mismatch' }
  }

  return { ok: true }
}
