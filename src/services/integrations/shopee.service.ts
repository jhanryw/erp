/**
 * Service da integração Shopee (Fase 1 — lojas conectadas).
 *
 * Multi-tenant por construção: toda operação recebe o company_id DA SESSÃO
 * (nunca de query/body) e todo acesso ao banco filtra por company_id +
 * provider='shopee'. O callback só aceita um state emitido para a MESMA
 * empresa E o MESMO usuário da sessão.
 *
 * Multi-loja: uma empresa pode ter N integrações Shopee (uma por shop_id).
 * Operações sobre uma loja recebem o integration_id, sempre validado contra
 * a empresa da sessão (integração de outra empresa = "não encontrada").
 *
 * Tokens cifrados (secretCipher) antes de sair do processo; nunca voltam ao
 * navegador. A view (ShopeeConnectionView) só tem metadados não sensíveis.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { encryptSecret } from '@/lib/security/secretCipher'
import { getShopeeConfig, isShopeeConfigured, type ShopeeConfig } from '@/lib/integrations/shopee/config'
import { ShopeeError, isShopeeError } from '@/lib/integrations/shopee/errors'
import type { FetchLike } from '@/lib/integrations/shopee/http'
import { logShopee } from '@/lib/integrations/shopee/log'
import {
  OAUTH_STATE_TTL_SECONDS,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generateOAuthState,
  hashOAuthState,
  isValidShopId,
  refreshTokens,
} from '@/lib/integrations/shopee/oauth'
import { SHOPEE_PROVIDER, createSupabaseShopeeTokenStore, getValidAccessToken, type ShopeeTokenStore } from '@/lib/integrations/shopee/tokens'

export { SHOPEE_PROVIDER }

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type ShopeeShopState = 'connected' | 'needs_reauth' | 'error' | 'disconnected'

export interface ShopeeShopView {
  integration_id: number
  shop_id: string | null
  state: ShopeeShopState
  connected_at: string | null
  disconnected_at: string | null
  credential_expires_at: string | null
  credential_refreshed_at: string | null
  last_error: string | null
}

export interface ShopeeConnectionView {
  configured: boolean
  shops: ShopeeShopView[]
}

export interface ShopeeIntegrationRow {
  id: number
  company_id: number
  status: string
  external_account_id: string | null
  settings: Record<string, unknown> | null
  last_error: string | null
  credential_expires_at: string | null
  credential_refreshed_at: string | null
  connected_at: string | null
  disconnected_at: string | null
}

export type ConsumeStateResult =
  | { status: 'ok'; company_id: number; user_id: string }
  | { status: 'not_found' | 'consumed' | 'expired' }

export interface ShopeeRepo {
  insertOAuthState(row: { state_hash: string; company_id: number; user_id: string; expires_at: string }): Promise<void>
  consumeOAuthState(stateHash: string): Promise<ConsumeStateResult>
  upsertIntegration(input: {
    companyId: number; shopId: string; settings: Record<string, unknown>
    accessCiphertext: string; refreshCiphertext: string; keyVersion: number
    tokenExpiresAt: string; userId: string
  }): Promise<{ integration_id: number; reconnected: boolean }>
  listIntegrations(companyId: number): Promise<ShopeeIntegrationRow[]>
  getIntegration(companyId: number, integrationId: number): Promise<ShopeeIntegrationRow | null>
  disconnect(integrationId: number, companyId: number, userId: string): Promise<boolean>
}

export interface ShopeeServiceDeps {
  repo?: ShopeeRepo
  store?: ShopeeTokenStore
  config?: ShopeeConfig
  fetchImpl?: FetchLike
  now?: () => Date
}

function resolveDeps(deps: ShopeeServiceDeps = {}) {
  return {
    repo: deps.repo ?? createSupabaseShopeeRepo(),
    config: deps.config ?? getShopeeConfig(),
    fetchImpl: deps.fetchImpl,
    now: deps.now ?? (() => new Date()),
  }
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

/** Gera state, grava (hash) vinculado a empresa+usuário da sessão, devolve a URL de autorização. */
export async function startShopeeOAuth(
  session: { userId: string; companyId: number },
  deps?: ShopeeServiceDeps,
): Promise<{ authorizationUrl: string }> {
  const { repo, config, now } = resolveDeps(deps)
  const state = generateOAuthState()
  await repo.insertOAuthState({
    state_hash: hashOAuthState(state),
    company_id: session.companyId,
    user_id: session.userId,
    expires_at: new Date(now().getTime() + OAUTH_STATE_TTL_SECONDS * 1000).toISOString(),
  })
  logShopee('shopee.oauth.started', { company_id: session.companyId, user_id: session.userId })
  return { authorizationUrl: buildAuthorizationUrl({ config, state }) }
}

export interface ShopeeCallbackParams {
  code: string | null
  shopId: string | null
  state: string | null
  error: string | null
}

/** Finaliza o OAuth. Retorna só identificadores — nunca tokens. */
export async function completeShopeeOAuth(
  session: { userId: string; companyId: number },
  params: ShopeeCallbackParams,
  deps?: ShopeeServiceDeps,
): Promise<{ integrationId: number; shopId: string; reconnected: boolean }> {
  const { repo, config, fetchImpl, now } = resolveDeps(deps)

  try {
    if (params.error) throw new ShopeeError('oauth_denied', 'Autorização recusada na Shopee.')
    if (!params.state) throw new ShopeeError('invalid_state', 'Callback sem state.')
    if (!params.code) throw new ShopeeError('invalid_callback', 'Callback sem code.')
    if (!isValidShopId(params.shopId)) throw new ShopeeError('invalid_callback', 'Callback sem shop_id válido.')

    const consumed = await repo.consumeOAuthState(hashOAuthState(params.state))
    if (consumed.status !== 'ok') throw new ShopeeError('invalid_state', `State OAuth ${consumed.status}.`)
    // A empresa vem do STATE (emitido para a sessão), nunca da URL; e tem de bater com a sessão atual.
    if (consumed.company_id !== session.companyId || consumed.user_id !== session.userId) {
      throw new ShopeeError('invalid_state', 'State OAuth emitido para outra empresa/usuário.')
    }
    const companyId = consumed.company_id

    const tokens = await exchangeCodeForTokens({ config, code: params.code, shopId: params.shopId, fetchImpl, now })
    const access = encryptSecret(tokens.accessToken)
    const refresh = encryptSecret(tokens.refreshToken)

    let result: { integration_id: number; reconnected: boolean }
    try {
      result = await repo.upsertIntegration({
        companyId,
        shopId: tokens.shopId,
        settings: { shop_id: tokens.shopId },
        accessCiphertext: access.ciphertext,
        refreshCiphertext: refresh.ciphertext,
        keyVersion: access.keyVersion,
        tokenExpiresAt: tokens.expiresAt.toISOString(),
        userId: session.userId,
      })
    } catch (err) {
      if (err instanceof Error && err.message.includes('account_linked_to_other_company')) {
        throw new ShopeeError('account_conflict', 'Esta loja Shopee já está conectada a outra empresa.')
      }
      throw err
    }

    logShopee('shopee.oauth.completed', {
      company_id: companyId, integration_id: result.integration_id, shop_id: tokens.shopId, user_id: session.userId,
      reason: result.reconnected ? 'reconnected' : 'connected',
    })
    return { integrationId: result.integration_id, shopId: tokens.shopId, reconnected: result.reconnected }
  } catch (err) {
    const e = isShopeeError(err) ? err : new ShopeeError('network', 'Falha inesperada no callback OAuth.')
    logShopee('shopee.oauth.failed', {
      company_id: session.companyId, user_id: session.userId, reason: e.kind, http_status: e.httpStatus, request_id: e.requestId,
    })
    throw e
  }
}

// ─── Estado / manutenção ─────────────────────────────────────────────────────

export function toShopView(row: ShopeeIntegrationRow): ShopeeShopView {
  const state: ShopeeShopState =
    row.status === 'needs_reauth' ? 'needs_reauth'
    : row.status === 'error' ? 'error'
    : row.status === 'active' ? 'connected'
    : 'disconnected'
  const prev = (row.settings as { previous_external_account_id?: unknown } | null)?.previous_external_account_id
  return {
    integration_id: row.id,
    shop_id: row.external_account_id ?? (typeof prev === 'string' ? prev : null),
    state,
    connected_at: row.connected_at,
    disconnected_at: row.disconnected_at,
    credential_expires_at: state === 'disconnected' ? null : row.credential_expires_at,
    credential_refreshed_at: row.credential_refreshed_at,
    last_error: state === 'connected' ? null : row.last_error,
  }
}

export async function getShopeeConnections(companyId: number, deps?: Pick<ShopeeServiceDeps, 'repo'>): Promise<ShopeeConnectionView> {
  const repo = deps?.repo ?? createSupabaseShopeeRepo()
  const rows = await repo.listIntegrations(companyId)
  return { configured: isShopeeConfigured(), shops: rows.map(toShopView) }
}

async function requireOwnIntegration(repo: ShopeeRepo, companyId: number, integrationId: number): Promise<ShopeeIntegrationRow> {
  if (!Number.isInteger(integrationId) || integrationId <= 0) throw new ShopeeError('integration_not_found', 'Integração Shopee não encontrada.')
  const row = await repo.getIntegration(companyId, integrationId)
  if (!row) throw new ShopeeError('integration_not_found', 'Integração Shopee não encontrada nesta empresa.')
  return row
}

/** Força a renovação do token de UMA loja da empresa. Nunca devolve o token. */
export async function forceRefreshShopeeToken(companyId: number, integrationId: number, deps?: ShopeeServiceDeps): Promise<ShopeeShopView> {
  const { repo, config, fetchImpl, now } = resolveDeps(deps)
  const store = deps?.store ?? createSupabaseShopeeTokenStore()
  const row = await requireOwnIntegration(repo, companyId, integrationId)
  if (row.status === 'inactive' || !row.external_account_id) throw new ShopeeError('integration_disabled', 'Loja Shopee desconectada.')
  const shopId = row.external_account_id

  await getValidAccessToken({
    integrationId: row.id,
    companyId,
    store,
    refresh: (rt) => refreshTokens({ config, refreshToken: rt, shopId, fetchImpl, now }),
    forceIfExpiresAt: row.credential_expires_at ? new Date(row.credential_expires_at) : new Date(0),
    now,
  })
  return toShopView((await repo.getIntegration(companyId, row.id))!)
}

/**
 * Desconecta UMA loja: apaga os tokens, marca inactive e PRESERVA a linha
 * (mesma RPC/semântica do Mercado Livre). A revogação do lado da Shopee é
 * feita pelo vendedor (Seller Center / link cancel_auth) — não há endpoint
 * server-side de revogação na documentação pesquisada.
 */
export async function disconnectShopee(companyId: number, integrationId: number, userId: string, deps?: Pick<ShopeeServiceDeps, 'repo'>): Promise<ShopeeShopView> {
  const repo = deps?.repo ?? createSupabaseShopeeRepo()
  const row = await requireOwnIntegration(repo, companyId, integrationId)
  if (row.status !== 'inactive') {
    const ok = await repo.disconnect(row.id, companyId, userId)
    if (!ok) throw new ShopeeError('integration_not_found', 'Integração não encontrada nesta empresa.')
    logShopee('shopee.integration.disconnected', { company_id: companyId, integration_id: row.id, shop_id: row.external_account_id, user_id: userId })
  }
  return toShopView((await repo.getIntegration(companyId, row.id))!)
}

// ─── Repo de produção ───────────────────────────────────────────────────────

const INTEGRATION_COLUMNS =
  'id, company_id, status, external_account_id, settings, last_error, credential_expires_at, credential_refreshed_at, connected_at, disconnected_at'

export function createSupabaseShopeeRepo(): ShopeeRepo {
  const admin = createAdminClient() as any

  return {
    async insertOAuthState(row) {
      const { error } = await admin.from('integration_oauth_states').insert({ ...row, provider: SHOPEE_PROVIDER })
      if (error) throw new ShopeeError('network', 'Falha ao iniciar a conexão (state).')
    },

    async consumeOAuthState(stateHash) {
      const { data, error } = await admin.rpc('rpc_consume_oauth_state', { p_provider: SHOPEE_PROVIDER, p_state_hash: stateHash })
      if (error || !data) throw new ShopeeError('network', 'Falha ao validar state OAuth.')
      return data as ConsumeStateResult
    },

    async upsertIntegration(input) {
      const { data, error } = await admin.rpc('rpc_upsert_oauth_account_integration', {
        p_company_id: input.companyId,
        p_provider: SHOPEE_PROVIDER,
        p_external_account_id: input.shopId,
        p_settings: input.settings,
        p_access_ciphertext: input.accessCiphertext,
        p_refresh_ciphertext: input.refreshCiphertext,
        p_key_version: input.keyVersion,
        p_credential_expires_at: input.tokenExpiresAt,
        p_oauth_scopes: null,
        p_user_id: input.userId,
      })
      if (error) throw new Error(error.message)
      return data as { integration_id: number; reconnected: boolean }
    },

    async listIntegrations(companyId) {
      const { data, error } = await admin
        .from('company_integrations')
        .select(INTEGRATION_COLUMNS)
        .eq('company_id', companyId)
        .eq('provider', SHOPEE_PROVIDER)
        .order('id', { ascending: true })
      if (error) throw new ShopeeError('network', 'Falha ao ler as integrações Shopee.')
      return (data ?? []) as ShopeeIntegrationRow[]
    },

    async getIntegration(companyId, integrationId) {
      const { data, error } = await admin
        .from('company_integrations')
        .select(INTEGRATION_COLUMNS)
        .eq('id', integrationId)
        .eq('company_id', companyId)
        .eq('provider', SHOPEE_PROVIDER)
        .maybeSingle()
      if (error) throw new ShopeeError('network', 'Falha ao ler a integração Shopee.')
      return (data ?? null) as ShopeeIntegrationRow | null
    },

    async disconnect(integrationId, companyId, userId) {
      const { data, error } = await admin.rpc('rpc_disconnect_oauth_integration', {
        p_integration_id: integrationId, p_company_id: companyId, p_user_id: userId,
      })
      if (error) throw new ShopeeError('network', 'Falha ao desconectar.')
      return data === true
    },
  }
}
