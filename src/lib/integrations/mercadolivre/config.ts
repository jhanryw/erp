/**
 * Configuração da APLICAÇÃO Qarvon no Mercado Livre (uma só, SaaS). Nível
 * separado dos tokens de cada empresa (esses ficam em integration_secrets).
 *
 * Variáveis de ambiente (servidor apenas — nunca NEXT_PUBLIC_*):
 *   MERCADOLIVRE_CLIENT_ID      APP ID do DevCenter
 *   MERCADOLIVRE_CLIENT_SECRET  Secret Key do DevCenter
 *   MERCADOLIVRE_REDIRECT_URI   exatamente a URL cadastrada no DevCenter
 *                               (ex.: https://<dominio>/api/integrations/mercadolivre/callback)
 *   MERCADOLIVRE_USE_PKCE       'true' (padrão) | 'false' — deve refletir a
 *                               opção PKCE do app no DevCenter
 *   MERCADOLIVRE_DEFAULT_SITE_ID  padrão MLB
 *   MERCADOLIVRE_API_URL        padrão https://api.mercadolibre.com
 */

import { MercadoLivreError } from './errors'

export interface MercadoLivreConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
  usePkce: boolean
  defaultSiteId: string
  apiBaseUrl: string
}

/**
 * Domínio de autorização por site (a autorização é por país; a API é única).
 * Fonte: documentação oficial "Autenticação e Autorização" (atualizada em
 * 29/12/2025) — "lembre-se de alterar pelo domínio do país correspondente".
 */
export const AUTH_BASE_BY_SITE: Readonly<Record<string, string>> = {
  MLB: 'https://auth.mercadolivre.com.br',
  MLA: 'https://auth.mercadolibre.com.ar',
  MLM: 'https://auth.mercadolibre.com.mx',
  MLC: 'https://auth.mercadolibre.cl',
  MCO: 'https://auth.mercadolibre.com.co',
  MLU: 'https://auth.mercadolibre.com.uy',
  MPE: 'https://auth.mercadolibre.com.pe',
}

export function authorizationBaseUrl(siteId: string): string {
  const base = AUTH_BASE_BY_SITE[siteId]
  if (!base) throw new MercadoLivreError('config', `site_id sem domínio de autorização configurado: ${siteId}`)
  return `${base}/authorization`
}

export function getMercadoLivreConfig(env: NodeJS.ProcessEnv = process.env): MercadoLivreConfig {
  const clientId = env.MERCADOLIVRE_CLIENT_ID?.trim()
  const clientSecret = env.MERCADOLIVRE_CLIENT_SECRET?.trim()
  const redirectUri = env.MERCADOLIVRE_REDIRECT_URI?.trim()

  const missing = [
    !clientId && 'MERCADOLIVRE_CLIENT_ID',
    !clientSecret && 'MERCADOLIVRE_CLIENT_SECRET',
    !redirectUri && 'MERCADOLIVRE_REDIRECT_URI',
  ].filter(Boolean)
  if (missing.length > 0) {
    throw new MercadoLivreError('config', `Integração Mercado Livre não configurada no servidor: ${missing.join(', ')}.`)
  }

  let parsed: URL
  try {
    parsed = new URL(redirectUri!)
  } catch {
    throw new MercadoLivreError('config', 'MERCADOLIVRE_REDIRECT_URI inválida.')
  }
  // Redirect fixa e sem parte variável (exigência do Mercado Livre).
  if (parsed.search || parsed.hash) {
    throw new MercadoLivreError('config', 'MERCADOLIVRE_REDIRECT_URI não pode ter query string nem fragmento.')
  }
  if (parsed.protocol !== 'https:' && env.NODE_ENV === 'production') {
    throw new MercadoLivreError('config', 'MERCADOLIVRE_REDIRECT_URI precisa ser https em produção.')
  }

  return {
    clientId: clientId!,
    clientSecret: clientSecret!,
    redirectUri: redirectUri!,
    usePkce: (env.MERCADOLIVRE_USE_PKCE ?? 'true').trim().toLowerCase() !== 'false',
    defaultSiteId: (env.MERCADOLIVRE_DEFAULT_SITE_ID ?? 'MLB').trim().toUpperCase(),
    apiBaseUrl: (env.MERCADOLIVRE_API_URL ?? 'https://api.mercadolibre.com').trim().replace(/\/+$/, ''),
  }
}

/** true quando as 3 variáveis obrigatórias existem — para a UI sem lançar. */
export function isMercadoLivreConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    getMercadoLivreConfig(env)
    return true
  } catch {
    return false
  }
}
