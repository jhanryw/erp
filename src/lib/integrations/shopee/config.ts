/**
 * Configuração da APLICAÇÃO Qarvon na Shopee Open Platform (uma só, SaaS).
 * Nível separado dos tokens de cada loja (esses ficam em integration_secrets).
 *
 * Variáveis de ambiente (servidor apenas — nunca NEXT_PUBLIC_*):
 *   SHOPEE_PARTNER_ID     partner_id do app no Shopee Open Platform (numérico)
 *   SHOPEE_PARTNER_KEY    partner_key (chave da assinatura HMAC) — SEGREDO
 *   SHOPEE_REDIRECT_URI   URL de retorno da autorização
 *                         (ex.: https://<dominio>/api/integrations/shopee/callback)
 *   SHOPEE_AUTH_URL       padrão https://open.shopee.com.br   (autorização, Brasil)
 *   SHOPEE_API_URL        padrão https://openplatform.shopee.com.br (API, Brasil)
 *
 * Sandbox: não há host de sandbox confirmado — os dois hosts são apenas
 * configuráveis por env para quando houver.
 */

import { ShopeeError } from './errors'

export const SHOPEE_DEFAULT_AUTH_URL = 'https://open.shopee.com.br'
export const SHOPEE_DEFAULT_API_URL = 'https://openplatform.shopee.com.br'

/** Paths da API (sem host) — base da assinatura. */
export const SHOPEE_PATHS = {
  authorize: '/auth',
  cancelAuthorize: '/cancel_auth',
  tokenGet: '/api/v2/auth/token/get',
  accessTokenGet: '/api/v2/auth/access_token/get',
  // Shop API — catálogo/publicação (paths conferidos na referência oficial v2, 28/09/2026)
  getCategory: '/api/v2/product/get_category',
  getAttributeTree: '/api/v2/product/get_attribute_tree',
  getBrandList: '/api/v2/product/get_brand_list',
  addItem: '/api/v2/product/add_item',
  getItemBaseInfo: '/api/v2/product/get_item_base_info',
  uploadImage: '/api/v2/media_space/upload_image',
  getChannelList: '/api/v2/logistics/get_channel_list',
} as const

export interface ShopeeConfig {
  partnerId: number
  partnerKey: string
  redirectUri: string
  authBaseUrl: string
  apiBaseUrl: string
}

function baseUrl(raw: string | undefined, fallback: string, name: string): string {
  const value = (raw ?? '').trim() || fallback
  try {
    const u = new URL(value)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol')
  } catch {
    throw new ShopeeError('config', `${name} inválida.`)
  }
  return value.replace(/\/+$/, '')
}

export function getShopeeConfig(env: NodeJS.ProcessEnv = process.env): ShopeeConfig {
  const partnerIdRaw = env.SHOPEE_PARTNER_ID?.trim()
  const partnerKey = env.SHOPEE_PARTNER_KEY?.trim()
  const redirectUri = env.SHOPEE_REDIRECT_URI?.trim()

  const missing = [
    !partnerIdRaw && 'SHOPEE_PARTNER_ID',
    !partnerKey && 'SHOPEE_PARTNER_KEY',
    !redirectUri && 'SHOPEE_REDIRECT_URI',
  ].filter(Boolean)
  if (missing.length > 0) {
    throw new ShopeeError('config', `Integração Shopee não configurada no servidor: ${missing.join(', ')}.`)
  }
  if (!/^\d+$/.test(partnerIdRaw!)) {
    throw new ShopeeError('config', 'SHOPEE_PARTNER_ID precisa ser numérico.')
  }

  let parsed: URL
  try {
    parsed = new URL(redirectUri!)
  } catch {
    throw new ShopeeError('config', 'SHOPEE_REDIRECT_URI inválida.')
  }
  if (parsed.hash) throw new ShopeeError('config', 'SHOPEE_REDIRECT_URI não pode ter fragmento.')
  if (parsed.protocol !== 'https:' && env.NODE_ENV === 'production') {
    throw new ShopeeError('config', 'SHOPEE_REDIRECT_URI precisa ser https em produção.')
  }

  return {
    partnerId: Number(partnerIdRaw),
    partnerKey: partnerKey!,
    redirectUri: redirectUri!,
    authBaseUrl: baseUrl(env.SHOPEE_AUTH_URL, SHOPEE_DEFAULT_AUTH_URL, 'SHOPEE_AUTH_URL'),
    apiBaseUrl: baseUrl(env.SHOPEE_API_URL, SHOPEE_DEFAULT_API_URL, 'SHOPEE_API_URL'),
  }
}

/** true quando a configuração é válida — para a UI sem lançar. */
export function isShopeeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    getShopeeConfig(env)
    return true
  } catch {
    return false
  }
}
