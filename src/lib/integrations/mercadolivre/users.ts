/**
 * Recursos de USUÁRIO/aplicação do Mercado Livre usados na Fase 1.
 * (Anúncios, pedidos e estoque ficam para as próximas fases.)
 */

import type { MercadoLivreConfig } from './config'
import { mlHttp, type FetchLike } from './http'
import { mercadoLivreRequest, type MercadoLivreRequestDeps } from './client'
import type { MercadoLivreMe } from './types'

/** GET /users/me com um access_token recém-obtido (callback, antes de existir integração). */
export async function fetchMeWithAccessToken(config: MercadoLivreConfig, accessToken: string, fetchImpl?: FetchLike): Promise<MercadoLivreMe> {
  const res = await mlHttp<MercadoLivreMe>({ baseUrl: config.apiBaseUrl, method: 'GET', path: '/users/me', accessToken, fetchImpl })
  return res.data
}

/** GET /users/me de uma integração existente (revalidação). */
export async function fetchMe(integrationId: number, companyId: number, deps?: MercadoLivreRequestDeps): Promise<MercadoLivreMe> {
  const res = await mercadoLivreRequest<MercadoLivreMe>({ integrationId, companyId, method: 'GET', path: '/users/me', deps })
  return res.data
}

/**
 * Revoga a autorização da conta para o app Qarvon
 * (DELETE /users/{user_id}/applications/{app_id} — doc "Gerencie seu aplicativo").
 */
export async function revokeApplicationGrant(
  integrationId: number,
  companyId: number,
  sellerId: string,
  config: MercadoLivreConfig,
  deps?: MercadoLivreRequestDeps,
): Promise<void> {
  await mercadoLivreRequest({
    integrationId, companyId, method: 'DELETE',
    path: `/users/${encodeURIComponent(sellerId)}/applications/${encodeURIComponent(config.clientId)}`,
    deps: { ...deps, config },
  })
}

export interface MercadoLivreTestUser {
  id: number
  nickname: string
  password: string
  site_status: string
}

/**
 * POST /users/test_user {site_id} (doc "Realização de testes"): até 10 por
 * conta, sem sandbox — o usuário TEST opera no ambiente real e só negocia
 * com outros usuários TEST. A resposta traz a senha UMA vez; quem chama é
 * responsável por entregá-la ao operador e NUNCA persistir/logar.
 * Uso restrito: ferramenta operacional (scripts/mercadolivre-test-user.mjs),
 * nunca exposta a usuários do SaaS.
 */
export async function createTestUser(
  integrationId: number,
  companyId: number,
  siteId: string,
  deps?: MercadoLivreRequestDeps,
): Promise<MercadoLivreTestUser> {
  const res = await mercadoLivreRequest<MercadoLivreTestUser>({
    integrationId, companyId, method: 'POST', path: '/users/test_user', body: { site_id: siteId }, deps,
  })
  return res.data
}
