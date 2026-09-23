/**
 * Service da integração Mercado Livre (Fase 1 — conta conectada).
 *
 * Multi-tenant por construção: toda operação recebe o company_id DA SESSÃO
 * (nunca de query/body/state externo) e todo acesso ao banco filtra por ele.
 * O callback OAuth só aceita um state emitido para a MESMA empresa E o MESMO
 * usuário da sessão que finaliza o fluxo.
 *
 * Tokens: cifrados (secretCipher) antes de sair do processo; nunca voltam
 * ao navegador, nunca vão para settings/logs/URL. A view devolvida à UI
 * (MercadoLivreConnectionView) só tem metadados não sensíveis.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { encryptSecret, decryptSecret } from '@/lib/security/secretCipher'
import { getMercadoLivreConfig, isMercadoLivreConfigured, type MercadoLivreConfig } from '@/lib/integrations/mercadolivre/config'
import { MercadoLivreError, isMercadoLivreError } from '@/lib/integrations/mercadolivre/errors'
import type { FetchLike } from '@/lib/integrations/mercadolivre/http'
import { logMercadoLivre } from '@/lib/integrations/mercadolivre/log'
import {
  OAUTH_STATE_TTL_SECONDS,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generateOAuthState,
  generatePkcePair,
  hashOAuthState,
  refreshTokens,
} from '@/lib/integrations/mercadolivre/oauth'
import { createSupabaseTokenStore, getValidAccessToken, type TokenStore } from '@/lib/integrations/mercadolivre/tokens'
import { accountSettingsFromMe, type MercadoLivreAccountSettings } from '@/lib/integrations/mercadolivre/types'
import { fetchMe, fetchMeWithAccessToken, revokeApplicationGrant } from '@/lib/integrations/mercadolivre/users'

export const MERCADOLIVRE_PROVIDER = 'mercadolivre'

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type MercadoLivreConnectionState = 'not_configured' | 'disconnected' | 'connected' | 'needs_reauth' | 'error'

export interface MercadoLivreConnectionView {
  state: MercadoLivreConnectionState
  integration_id: number | null
  seller_id: string | null
  nickname: string | null
  site_id: string | null
  country_id: string | null
  permalink: string | null
  is_test_user: boolean
  connected_at: string | null
  disconnected_at: string | null
  last_validated_at: string | null
  credential_expires_at: string | null
  credential_refreshed_at: string | null
  last_error: string | null
}

export interface IntegrationRow {
  id: number
  company_id: number
  status: string
  external_account_id: string | null
  settings: Record<string, unknown> | null
  last_error: string | null
  credential_expires_at: string | null
  credential_refreshed_at: string | null
  last_validated_at: string | null
  connected_at: string | null
  disconnected_at: string | null
}

export type ConsumeStateResult =
  | { status: 'ok'; company_id: number; user_id: string; code_verifier_ciphertext: string | null; code_verifier_key_version: number | null }
  | { status: 'not_found' | 'consumed' | 'expired' }

/** Acesso a dados — produção: Supabase/RPCs. Testes: implementação em memória. */
export interface MercadoLivreRepo {
  insertOAuthState(row: {
    state_hash: string; company_id: number; user_id: string
    code_verifier_ciphertext: string | null; code_verifier_key_version: number | null; expires_at: string
  }): Promise<void>
  consumeOAuthState(stateHash: string): Promise<ConsumeStateResult>
  upsertIntegration(input: {
    companyId: number; externalAccountId: string; settings: Record<string, unknown>
    accessCiphertext: string; refreshCiphertext: string; keyVersion: number
    tokenExpiresAt: string; tokenScopes: string[]; userId: string
  }): Promise<{ integration_id: number; reconnected: boolean }>
  getIntegration(companyId: number): Promise<IntegrationRow | null>
  updateValidation(integrationId: number, companyId: number, settings: Record<string, unknown>): Promise<void>
  disconnect(integrationId: number, companyId: number, userId: string): Promise<boolean>
}

export interface MercadoLivreServiceDeps {
  repo?: MercadoLivreRepo
  store?: TokenStore
  config?: MercadoLivreConfig
  fetchImpl?: FetchLike
  now?: () => Date
}

function resolveDeps(deps: MercadoLivreServiceDeps = {}) {
  return {
    repo: deps.repo ?? createSupabaseMercadoLivreRepo(),
    store: deps.store,
    config: deps.config ?? getMercadoLivreConfig(),
    fetchImpl: deps.fetchImpl,
    now: deps.now ?? (() => new Date()),
  }
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

/** Gera state (+PKCE), grava vinculado a empresa+usuário, devolve a URL de autorização. */
export async function startMercadoLivreOAuth(
  session: { userId: string; companyId: number },
  deps?: MercadoLivreServiceDeps,
): Promise<{ authorizationUrl: string }> {
  const { repo, config, now } = resolveDeps(deps)

  const state = generateOAuthState()
  const pkce = config.usePkce ? generatePkcePair() : null
  const verifier = pkce ? encryptSecret(pkce.verifier) : null

  await repo.insertOAuthState({
    state_hash: hashOAuthState(state),
    company_id: session.companyId,
    user_id: session.userId,
    code_verifier_ciphertext: verifier?.ciphertext ?? null,
    code_verifier_key_version: verifier?.keyVersion ?? null,
    expires_at: new Date(now().getTime() + OAUTH_STATE_TTL_SECONDS * 1000).toISOString(),
  })

  logMercadoLivre('mercadolivre.oauth.started', { company_id: session.companyId, user_id: session.userId })
  return { authorizationUrl: buildAuthorizationUrl({ config, state, codeChallenge: pkce?.challenge }) }
}

export interface CallbackParams {
  code: string | null
  state: string | null
  error: string | null
}

/**
 * Finaliza o OAuth. Retorna só identificadores — nunca tokens.
 * Lança MercadoLivreError tipado; a rota converte em redirect com um
 * código de motivo (sem detalhes sensíveis).
 */
export async function completeMercadoLivreOAuth(
  session: { userId: string; companyId: number },
  params: CallbackParams,
  deps?: MercadoLivreServiceDeps,
): Promise<{ integrationId: number; sellerId: string; reconnected: boolean; account: MercadoLivreAccountSettings }> {
  const { repo, config, fetchImpl } = resolveDeps(deps)

  try {
    if (params.error) {
      throw new MercadoLivreError('oauth_denied', `Autorização recusada no Mercado Livre (${params.error}).`)
    }
    if (!params.state) throw new MercadoLivreError('invalid_state', 'Callback sem state.')
    if (!params.code) throw new MercadoLivreError('invalid_state', 'Callback sem code.')

    const consumed = await repo.consumeOAuthState(hashOAuthState(params.state))
    if (consumed.status !== 'ok') {
      throw new MercadoLivreError('invalid_state', `State OAuth ${consumed.status}.`)
    }
    // Tenant crossover / sessão trocada: o state tem de ser desta empresa E deste usuário.
    if (consumed.company_id !== session.companyId || consumed.user_id !== session.userId) {
      throw new MercadoLivreError('invalid_state', 'State OAuth emitido para outra empresa/usuário.')
    }

    const codeVerifier = consumed.code_verifier_ciphertext && consumed.code_verifier_key_version
      ? decryptSecret(consumed.code_verifier_ciphertext, consumed.code_verifier_key_version)
      : null

    const tokens = await exchangeCodeForTokens({ config, code: params.code, codeVerifier, fetchImpl })
    const me = await fetchMeWithAccessToken(config, tokens.accessToken, fetchImpl)
    if (String(me.id) !== tokens.userId) {
      throw new MercadoLivreError('bad_request', 'user_id do token difere de /users/me.')
    }
    const account = accountSettingsFromMe(me, config.defaultSiteId)

    const access = encryptSecret(tokens.accessToken)
    const refresh = encryptSecret(tokens.refreshToken)
    let result: { integration_id: number; reconnected: boolean }
    try {
      result = await repo.upsertIntegration({
        companyId: session.companyId,
        externalAccountId: account.seller_id,
        settings: { ...account },
        accessCiphertext: access.ciphertext,
        refreshCiphertext: refresh.ciphertext,
        keyVersion: access.keyVersion,
        tokenExpiresAt: tokens.expiresAt.toISOString(),
        tokenScopes: tokens.scopes,
        userId: session.userId,
      })
    } catch (err) {
      if (err instanceof Error && err.message.includes('account_linked_to_other_company')) {
        throw new MercadoLivreError('account_conflict', 'Esta conta do Mercado Livre já está conectada a outra empresa.')
      }
      throw err
    }

    logMercadoLivre('mercadolivre.oauth.completed', {
      company_id: session.companyId, integration_id: result.integration_id, seller_id: account.seller_id, user_id: session.userId,
      reason: result.reconnected ? 'reconnected' : 'connected',
    })
    return { integrationId: result.integration_id, sellerId: account.seller_id, reconnected: result.reconnected, account }
  } catch (err) {
    const e = isMercadoLivreError(err) ? err : new MercadoLivreError('network', 'Falha inesperada no callback OAuth.')
    logMercadoLivre('mercadolivre.oauth.failed', {
      company_id: session.companyId, user_id: session.userId, reason: e.kind, http_status: e.httpStatus, request_id: e.requestId,
    })
    throw e
  }
}

// ─── Estado / manutenção ─────────────────────────────────────────────────────

export function toConnectionView(row: IntegrationRow | null, configured = true): MercadoLivreConnectionView {
  const s = (row?.settings ?? {}) as Partial<MercadoLivreAccountSettings> & { previous_external_account_id?: string }
  let state: MercadoLivreConnectionState
  if (!configured && (!row || row.status !== 'active')) state = 'not_configured'
  else if (!row || row.status === 'inactive' || row.status === 'pending') state = 'disconnected'
  else if (row.status === 'needs_reauth') state = 'needs_reauth'
  else if (row.status === 'error') state = 'error'
  else state = 'connected'

  const connectedish = state === 'connected' || state === 'needs_reauth' || state === 'error'
  return {
    state,
    integration_id: row?.id ?? null,
    seller_id: connectedish ? row?.external_account_id ?? null : null,
    nickname: connectedish ? s.nickname ?? null : null,
    site_id: connectedish ? s.site_id ?? null : null,
    country_id: connectedish ? s.country_id ?? null : null,
    permalink: connectedish ? s.permalink ?? null : null,
    is_test_user: connectedish ? Boolean(s.is_test_user) : false,
    connected_at: row?.connected_at ?? null,
    disconnected_at: row?.disconnected_at ?? null,
    last_validated_at: row?.last_validated_at ?? null,
    credential_expires_at: connectedish ? row?.credential_expires_at ?? null : null,
    credential_refreshed_at: row?.credential_refreshed_at ?? null,
    last_error: state === 'connected' ? null : row?.last_error ?? null,
  }
}

export async function getMercadoLivreConnection(companyId: number, deps?: Pick<MercadoLivreServiceDeps, 'repo'>): Promise<MercadoLivreConnectionView> {
  const repo = deps?.repo ?? createSupabaseMercadoLivreRepo()
  return toConnectionView(await repo.getIntegration(companyId), isMercadoLivreConfigured())
}

/** GET /users/me pela integração (renova token se preciso) e atualiza a validação. */
export async function revalidateMercadoLivreConnection(companyId: number, deps?: MercadoLivreServiceDeps): Promise<MercadoLivreConnectionView> {
  const { repo, config, fetchImpl, store } = resolveDeps(deps)
  const row = await repo.getIntegration(companyId)
  if (!row || row.status === 'inactive') throw new MercadoLivreError('integration_disabled', 'Mercado Livre não está conectado.')

  const me = await fetchMe(row.id, companyId, { config, fetchImpl, store })
  const account = accountSettingsFromMe(me, config.defaultSiteId)
  if (row.external_account_id && account.seller_id !== row.external_account_id) {
    throw new MercadoLivreError('bad_request', 'A conta autorizada não corresponde à conta conectada.')
  }
  await repo.updateValidation(row.id, companyId, { ...account })
  logMercadoLivre('mercadolivre.integration.validated', { company_id: companyId, integration_id: row.id, seller_id: account.seller_id })
  return toConnectionView(await repo.getIntegration(companyId))
}

/** Força a renovação do token (homologação/diagnóstico). Nunca devolve o token. */
export async function forceRefreshMercadoLivreToken(companyId: number, deps?: MercadoLivreServiceDeps): Promise<MercadoLivreConnectionView> {
  const { repo, config, fetchImpl } = resolveDeps(deps)
  const store = deps?.store ?? createSupabaseTokenStore()
  const row = await repo.getIntegration(companyId)
  if (!row || row.status === 'inactive') throw new MercadoLivreError('integration_disabled', 'Mercado Livre não está conectado.')

  await getValidAccessToken({
    integrationId: row.id,
    companyId,
    store,
    refresh: (rt) => refreshTokens({ config, refreshToken: rt, fetchImpl }),
    forceIfExpiresAt: row.credential_expires_at ? new Date(row.credential_expires_at) : new Date(0),
  })
  return toConnectionView(await repo.getIntegration(companyId))
}

/**
 * Desconecta: tenta revogar a autorização no Mercado Livre (melhor
 * esforço — falha não impede a desconexão local), apaga os tokens, marca
 * inactive e PRESERVA a linha (auditoria; vínculos futuros de anúncios/
 * pedidos continuam apontando para ela).
 */
export async function disconnectMercadoLivre(companyId: number, userId: string, deps?: MercadoLivreServiceDeps): Promise<MercadoLivreConnectionView> {
  const { repo, config, fetchImpl, store } = resolveDeps(deps)
  const row = await repo.getIntegration(companyId)
  if (!row || row.status === 'inactive') return toConnectionView(row)

  if (row.external_account_id && row.status === 'active') {
    try {
      await revokeApplicationGrant(row.id, companyId, row.external_account_id, config, { fetchImpl, store })
    } catch (err) {
      const e = isMercadoLivreError(err) ? err : null
      logMercadoLivre('mercadolivre.integration.disconnected', {
        company_id: companyId, integration_id: row.id, reason: `revoke_failed:${e?.kind ?? 'unknown'}`, http_status: e?.httpStatus ?? null,
      })
    }
  }

  const ok = await repo.disconnect(row.id, companyId, userId)
  if (!ok) throw new MercadoLivreError('integration_not_found', 'Integração não encontrada nesta empresa.')
  logMercadoLivre('mercadolivre.integration.disconnected', {
    company_id: companyId, integration_id: row.id, seller_id: row.external_account_id, user_id: userId,
  })
  return toConnectionView(await repo.getIntegration(companyId))
}

// ─── Refresh proativo (job) ─────────────────────────────────────────────────

export interface ProactiveRefreshResult {
  candidates: number
  refreshed: number
  needs_reauth: number
  failed: number
}

/**
 * Renova tokens que expiram dentro de `windowMinutes`, integração por
 * integração, usando o MESMO lease do refresh sob demanda (nunca disputa o
 * refresh_token com uma requisição em andamento). Cada integração é lida
 * com o seu próprio company_id — nenhuma operação cruza empresas.
 */
export async function refreshExpiringMercadoLivreTokens(
  options: { windowMinutes?: number; limit?: number; workerId?: string } = {},
  deps?: MercadoLivreServiceDeps,
): Promise<ProactiveRefreshResult> {
  const config = deps?.config ?? getMercadoLivreConfig()
  const store = deps?.store ?? createSupabaseTokenStore()
  const admin = createAdminClient() as any
  const until = new Date(Date.now() + (options.windowMinutes ?? 60) * 60_000).toISOString()

  const { data, error } = await admin
    .from('company_integrations')
    .select('id, company_id, credential_expires_at')
    .eq('provider', MERCADOLIVRE_PROVIDER)
    .eq('status', 'active')
    .lt('credential_expires_at', until)
    .order('credential_expires_at', { ascending: true })
    .limit(options.limit ?? 50)
  if (error) throw new MercadoLivreError('network', 'Falha ao listar integrações para refresh.')

  const result: ProactiveRefreshResult = { candidates: (data ?? []).length, refreshed: 0, needs_reauth: 0, failed: 0 }
  for (const row of (data ?? []) as Array<{ id: number; company_id: number; credential_expires_at: string }>) {
    try {
      const r = await getValidAccessToken({
        integrationId: row.id,
        companyId: row.company_id,
        store,
        refresh: (rt) => refreshTokens({ config, refreshToken: rt, fetchImpl: deps?.fetchImpl }),
        forceIfExpiresAt: new Date(row.credential_expires_at),
        workerId: options.workerId,
        waitMs: 5_000,
      })
      if (r.refreshed) result.refreshed++
    } catch (err) {
      if (isMercadoLivreError(err) && err.kind === 'reauth_required') result.needs_reauth++
      else result.failed++
    }
  }
  return result
}

// ─── Repo de produção ───────────────────────────────────────────────────────

const INTEGRATION_COLUMNS =
  'id, company_id, status, external_account_id, settings, last_error, credential_expires_at, credential_refreshed_at, last_validated_at, connected_at, disconnected_at'

export function createSupabaseMercadoLivreRepo(): MercadoLivreRepo {
  const admin = createAdminClient() as any

  return {
    async insertOAuthState(row) {
      const { error } = await admin.from('integration_oauth_states').insert({ ...row, provider: MERCADOLIVRE_PROVIDER })
      if (error) throw new MercadoLivreError('network', 'Falha ao iniciar a conexão (state).')
    },

    async consumeOAuthState(stateHash) {
      const { data, error } = await admin.rpc('rpc_consume_oauth_state', { p_provider: MERCADOLIVRE_PROVIDER, p_state_hash: stateHash })
      if (error || !data) throw new MercadoLivreError('network', 'Falha ao validar state OAuth.')
      return data as ConsumeStateResult
    },

    async upsertIntegration(input) {
      const { data, error } = await admin.rpc('rpc_upsert_oauth_integration', {
        p_company_id: input.companyId,
        p_provider: MERCADOLIVRE_PROVIDER,
        p_external_account_id: input.externalAccountId,
        p_settings: input.settings,
        p_access_ciphertext: input.accessCiphertext,
        p_refresh_ciphertext: input.refreshCiphertext,
        p_key_version: input.keyVersion,
        p_credential_expires_at: input.tokenExpiresAt,
        p_oauth_scopes: input.tokenScopes,
        p_user_id: input.userId,
      })
      if (error) throw new Error(error.message)
      return data as { integration_id: number; reconnected: boolean }
    },

    async getIntegration(companyId) {
      const { data, error } = await admin
        .from('company_integrations')
        .select(INTEGRATION_COLUMNS)
        .eq('company_id', companyId)
        .eq('provider', MERCADOLIVRE_PROVIDER)
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (error) throw new MercadoLivreError('network', 'Falha ao ler a integração Mercado Livre.')
      return (data ?? null) as IntegrationRow | null
    },

    async updateValidation(integrationId, companyId, settings) {
      const { data: current } = await admin
        .from('company_integrations').select('settings').eq('id', integrationId).eq('company_id', companyId).maybeSingle()
      const { error } = await admin
        .from('company_integrations')
        .update({
          settings: { ...(current?.settings ?? {}), ...settings },
          last_validated_at: new Date().toISOString(),
          last_error: null,
        })
        .eq('id', integrationId)
        .eq('company_id', companyId)
        .in('status', ['active', 'error'])
      if (error) throw new MercadoLivreError('network', 'Falha ao registrar validação.')
    },

    async disconnect(integrationId, companyId, userId) {
      const { data, error } = await admin.rpc('rpc_disconnect_oauth_integration', {
        p_integration_id: integrationId, p_company_id: companyId, p_user_id: userId,
      })
      if (error) throw new MercadoLivreError('network', 'Falha ao desconectar.')
      return data === true
    },
  }
}
