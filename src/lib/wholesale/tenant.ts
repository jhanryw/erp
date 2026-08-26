/**
 * Resolução de tenant do site de atacado — Fase 8 (Site de Atacado).
 *
 * Auditoria curta confirmou: não existe nenhuma infraestrutura de
 * subdomínio/domínio por empresa neste projeto (grep em `middleware.ts` e
 * em toda `src/`, nenhuma resolução de tenant por host). Multi-tenant
 * hoje é 100% orientado a SESSÃO (staff logado → `public.users.company_id`)
 * — não existe um equivalente pra requisição SEM sessão de staff.
 *
 * Mesmo padrão JÁ usado pelo webhook Nuvemshop
 * (`src/app/api/webhooks/nuvemshop/order/route.ts`, `NUVEMSHOP_SYSTEM_USER_ID`):
 * resolve o tenant através de um "usuário de sistema" configurado por
 * variável de ambiente, cujo `company_id` é a fonte de verdade. Reaproveita
 * exatamente essa ideia — `WHOLESALE_SITE_SYSTEM_USER_ID` aponta pra um
 * `public.users` real, e o `company_id` dele é o tenant do site.
 *
 * Nunca aceita `company_id` vindo do browser em nenhum ponto do site de
 * atacado — sempre resolvido aqui, no servidor.
 *
 * Ponto único de mudança futura: se o projeto ganhar subdomínio/domínio
 * por empresa, só esta função muda (ex.: resolver por `request.headers.
 * get('host')` contra uma tabela `company_domains`) — nenhum outro código
 * do site de atacado precisa saber como o tenant foi resolvido.
 */

import { createAdminClient } from '@/lib/supabase/admin'

export interface WholesaleTenant {
  companyId: number
  /** Usado como `systemUserId` em `createSale()` — mesmo papel que `NUVEMSHOP_SYSTEM_USER_ID` já cumpre pro webhook. */
  systemUserId: string
}

let cached: WholesaleTenant | null | undefined

/**
 * Resolve o tenant do site de atacado. `null` quando `WHOLESALE_SITE_
 * SYSTEM_USER_ID` não está configurado ou aponta pra um usuário sem
 * empresa — quem chama trata isso como "site de atacado não configurado
 * nesta instância", nunca inventa um company_id de fallback.
 *
 * Cacheado em memória do processo (mesmo padrão de configuração estática
 * lida uma vez) — a env var não muda em runtime.
 */
export async function resolveWholesaleSiteTenant(): Promise<WholesaleTenant | null> {
  if (cached !== undefined) return cached

  const systemUserId = process.env.WHOLESALE_SITE_SYSTEM_USER_ID
  if (!systemUserId) {
    cached = null
    return null
  }

  const admin = createAdminClient()
  const { data } = await (admin as any)
    .from('users')
    .select('company_id')
    .eq('id', systemUserId)
    .maybeSingle() as { data: { company_id: number | null } | null }

  if (!data?.company_id) {
    cached = null
    return null
  }

  cached = { companyId: data.company_id, systemUserId }
  return cached
}

/** Só pra testes — nunca chamado em código de produção. */
export function __resetWholesaleTenantCache() {
  cached = undefined
}
