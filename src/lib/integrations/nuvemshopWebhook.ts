/**
 * Validação de webhooks Nuvemshop (HMAC-SHA256 do body bruto com o client
 * secret do app, header `x-linkedstore-hmac-sha256`).
 *
 * Mesma regra do webhook de pedidos (`api/webhooks/nuvemshop/order`), que
 * mantém sua cópia local para não alterar o fluxo de pedidos nesta fase.
 */

import { createHmac, timingSafeEqual } from 'crypto'

export function verifyNuvemshopHmac(rawBody: string, receivedHmac: string, secret: string): boolean {
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex'))
  const received = Buffer.from(receivedHmac)
  if (expected.length !== received.length) return false
  return timingSafeEqual(expected, received)
}

export type NuvemshopWebhookAuth =
  | { ok: true }
  | { ok: false; status: 401 | 500; error: string }

/** HMAC obrigatório; bypass só fora de produção com NUVEMSHOP_SKIP_WEBHOOK_HMAC=true. */
export function authenticateNuvemshopWebhook(rawBody: string, headers: Headers): NuvemshopWebhookAuth {
  const skip = process.env.NODE_ENV !== 'production' && process.env.NUVEMSHOP_SKIP_WEBHOOK_HMAC === 'true'
  if (skip) return { ok: true }
  const secret = process.env.NUVEMSHOP_CLIENT_SECRET
  if (!secret) return { ok: false, status: 500, error: 'Configuração inválida do servidor.' }
  const received = headers.get('x-linkedstore-hmac-sha256') ?? ''
  if (!received || !verifyNuvemshopHmac(rawBody, received, secret)) return { ok: false, status: 401, error: 'Assinatura inválida.' }
  return { ok: true }
}
