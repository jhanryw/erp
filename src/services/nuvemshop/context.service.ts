/**
 * Resolução de contexto Nuvemshop: empresa → integração → loja → credenciais.
 *
 * Único lugar que decide "qual loja Nuvemshop pertence a qual empresa".
 * Toda lógica nova de produto/estoque/webhook parte de um NuvemshopContext —
 * nunca de env direto nem de um ID remoto solto.
 *
 * Ordem de resolução:
 *   1. `company_integrations` (provider='nuvemshop', status='active') com
 *      `external_account_id` = store_id e segredo `access_token` em
 *      `integration_secrets`.
 *   2. Legado (enquanto a Santtorini não tiver a linha acima): env
 *      NUVEMSHOP_STORE_ID + NUVEMSHOP_ACCESS_TOKEN, válido SOMENTE para a
 *      empresa do NUVEMSHOP_SYSTEM_USER_ID. Qualquer outra empresa recebe
 *      "não configurada" — nunca a loja de outra empresa.
 *
 * Limitação conhecida: `produto_map` não tem coluna de loja, então o
 * isolamento dos mappings é por EMPRESA. Uma empresa com duas lojas
 * Nuvemshop ativas é recusada (409) em vez de misturar mappings.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { NuvemshopCredentials } from '@/lib/integrations/nuvemshop'
import type { ServiceOutcome } from '../produtos.service'
import { listCompanyIntegrations, findIntegrationByExternalAccount } from '../integrations/company-integrations.service'
import { getIntegrationSecret } from '../integrations/secrets.service'

export const NUVEMSHOP_ACCESS_TOKEN_SECRET_KEY = 'access_token'

export interface NuvemshopContext {
  companyId:     number
  storeId:       string
  integrationId: number | null
  source:        'company_integration' | 'legacy_env'
  credentials:   NuvemshopCredentials
}

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

/** Empresa dona da configuração legada via env (NUVEMSHOP_SYSTEM_USER_ID). */
async function resolveLegacyEnvCompanyId(): Promise<ServiceOutcome<number | null>> {
  const systemUserId = process.env.NUVEMSHOP_SYSTEM_USER_ID
  if (!systemUserId || !process.env.NUVEMSHOP_STORE_ID || !process.env.NUVEMSHOP_ACCESS_TOKEN) {
    return success(null)
  }
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('users')
    .select('company_id')
    .eq('id', systemUserId)
    .maybeSingle() as { data: { company_id: number | null } | null; error: { message: string } | null }
  if (error) return failure(error.message)
  return success(data?.company_id ?? null)
}

function legacyContext(companyId: number): NuvemshopContext {
  const storeId = String(process.env.NUVEMSHOP_STORE_ID)
  return {
    companyId,
    storeId,
    integrationId: null,
    source:        'legacy_env',
    credentials:   { storeId, accessToken: String(process.env.NUVEMSHOP_ACCESS_TOKEN) },
  }
}

/** Contexto Nuvemshop da empresa (usuário logado, job, service interno). */
export async function resolveNuvemshopContextForCompany(
  companyId: number,
): Promise<ServiceOutcome<NuvemshopContext>> {
  if (!Number.isInteger(companyId) || companyId <= 0) return failure('Empresa inválida.', 403)

  const integrations = await listCompanyIntegrations(companyId)
  if (!integrations.ok) return integrations
  const active = integrations.data.filter((i) => i.provider === 'nuvemshop' && i.status === 'active')

  if (active.length > 1) {
    return failure('Mais de uma loja Nuvemshop ativa para esta empresa — não suportado pelos mappings atuais.', 409)
  }

  if (active.length === 1) {
    const integration = active[0]
    if (!integration.external_account_id) return failure('Integração Nuvemshop sem store_id (external_account_id).', 422)
    const token = await getIntegrationSecret(integration.id, companyId, NUVEMSHOP_ACCESS_TOKEN_SECRET_KEY)
    if (!token.ok) return token
    if (!token.data) return failure('Integração Nuvemshop sem access_token configurado.', 422)
    return success({
      companyId,
      storeId:       integration.external_account_id,
      integrationId: integration.id,
      source:        'company_integration',
      credentials:   { storeId: integration.external_account_id, accessToken: token.data },
    })
  }

  const legacy = await resolveLegacyEnvCompanyId()
  if (!legacy.ok) return legacy
  if (legacy.data !== companyId) return failure('Nuvemshop não configurada para esta empresa.', 404)
  return success(legacyContext(companyId))
}

/**
 * Contexto a partir do `store_id` que chegou num webhook. `null` quando a
 * loja não pertence a nenhuma empresa — o chamador ignora o evento.
 */
export async function resolveNuvemshopContextForStore(
  storeId: string,
): Promise<ServiceOutcome<NuvemshopContext | null>> {
  const normalized = String(storeId ?? '').trim()
  if (!/^\d+$/.test(normalized)) return success(null)

  const integration = await findIntegrationByExternalAccount('nuvemshop', normalized)
  if (!integration.ok) return integration
  if (integration.data) {
    const ctx = await resolveNuvemshopContextForCompany(integration.data.company_id)
    if (!ctx.ok) return ctx
    return success(ctx.data.storeId === normalized ? ctx.data : null)
  }

  if (normalized !== String(process.env.NUVEMSHOP_STORE_ID ?? '')) return success(null)
  const legacy = await resolveLegacyEnvCompanyId()
  if (!legacy.ok) return legacy
  if (!legacy.data) return success(null)
  // A empresa do env pode já ter migrado para company_integrations com OUTRA
  // loja — nesse caso o store_id do env não vale mais.
  const ctx = await resolveNuvemshopContextForCompany(legacy.data)
  if (!ctx.ok) return ctx.status === 404 ? success(null) : ctx
  return success(ctx.data.storeId === normalized ? ctx.data : null)
}
