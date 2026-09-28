/**
 * Assinatura HMAC-SHA256 da Shopee Open Platform v2 — ÚNICO lugar do projeto
 * que toca a partner_key para assinar.
 *
 *   Public API (auth/token/get, auth/access_token/get):
 *     base = partner_id + api_path + timestamp
 *   Shop API:
 *     base = partner_id + api_path + timestamp + access_token + shop_id
 *
 * Concatenação direta, sem separador. sign = hex lowercase de
 * HMAC-SHA256(partner_key, base). `api_path` é o path sem host
 * (ex.: /api/v2/auth/token/get); `timestamp` em segundos (janela de 5 min).
 *
 * Nenhuma mensagem de erro daqui contém a partner_key, o access_token ou a
 * base string (que inclui o access_token nas Shop APIs).
 */

import { createHmac } from 'node:crypto'
import { ShopeeError } from './errors'

export interface PublicSignInput {
  partnerId: number
  partnerKey: string
  path: string
  timestamp: number
}

export interface ShopSignInput extends PublicSignInput {
  accessToken: string
  shopId: number | string
}

function assertCommon(input: PublicSignInput): void {
  if (!Number.isInteger(input.partnerId) || input.partnerId <= 0) {
    throw new ShopeeError('config', 'Assinatura Shopee: partner_id inválido.')
  }
  if (typeof input.partnerKey !== 'string' || input.partnerKey.length === 0) {
    throw new ShopeeError('config', 'Assinatura Shopee: partner_key ausente.')
  }
  if (typeof input.path !== 'string' || !input.path.startsWith('/') || input.path.includes('?') || /^\/\//.test(input.path)) {
    throw new ShopeeError('config', 'Assinatura Shopee: api_path precisa ser um path absoluto sem host nem query.')
  }
  if (!Number.isInteger(input.timestamp) || input.timestamp <= 0) {
    throw new ShopeeError('config', 'Assinatura Shopee: timestamp (segundos) inválido.')
  }
}

function hmacHex(partnerKey: string, base: string): string {
  return createHmac('sha256', partnerKey).update(base, 'utf8').digest('hex')
}

/** Base string da Public API (sem access_token nem shop_id). */
export function publicBaseString(input: Omit<PublicSignInput, 'partnerKey'>): string {
  return `${input.partnerId}${input.path}${input.timestamp}`
}

export function signPublicRequest(input: PublicSignInput): string {
  assertCommon(input)
  return hmacHex(input.partnerKey, publicBaseString(input))
}

export function signShopRequest(input: ShopSignInput): string {
  assertCommon(input)
  if (typeof input.accessToken !== 'string' || input.accessToken.length === 0) {
    throw new ShopeeError('unauthorized', 'Assinatura Shopee: access_token ausente.')
  }
  const shopId = String(input.shopId)
  if (!/^\d+$/.test(shopId)) {
    throw new ShopeeError('bad_request', 'Assinatura Shopee: shop_id inválido.')
  }
  return hmacHex(input.partnerKey, `${publicBaseString(input)}${input.accessToken}${shopId}`)
}

/** Timestamp Unix em segundos (o que a Shopee espera). */
export function shopeeTimestamp(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000)
}
