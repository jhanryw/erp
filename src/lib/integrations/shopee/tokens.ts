/**
 * Access token válido para uma loja Shopee — com refresh seguro sob
 * concorrência. Mesmo algoritmo de `mercadolivre/tokens.ts` (lease/fencing
 * sobre as MESMAS RPCs genéricas rpc_claim/complete/fail_integration_token_refresh,
 * que só recebem integration_id + company_id):
 *
 *   1. token válido (margem de 5 min) → devolve;
 *   2. expirado → tenta o lease; só um worker ganha;
 *   3. o dono confere de novo, relê o refresh_token ATUAL, chama
 *      /api/v2/auth/access_token/get e grava o par novo + libera o lease na
 *      mesma transação, só se ainda for o dono (fencing);
 *   4. quem perdeu espera e reutiliza o token NOVO — nunca consome o
 *      refresh_token (uso único na Shopee) que o outro já rotacionou;
 *   5. reauth_required → needs_reauth, sem retry. Falha transitória →
 *      lease liberado, status mantido, erro `retryable`.
 *
 * Por que duplicado e não extraído: o TokenStore do ML é tipado com
 * MercadoLivreTokens (userId/scopes) e a função loga eventos do ML; extrair
 * exigiria mexer em código de produção do ML. Duplicação seletiva e isolada.
 */

import { randomUUID } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { encryptSecret } from '@/lib/security/secretCipher'
import { getIntegrationSecret } from '@/services/integrations/secrets.service'
import { ShopeeError, isShopeeError } from './errors'
import { logShopee } from './log'
import type { ShopeeTokens } from './types'

export const SHOPEE_PROVIDER = 'shopee'
export const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000
export const REFRESH_LEASE_SECONDS = 60
export const REFRESH_WAIT_MS = 20_000
export const REFRESH_POLL_MS = 250

export interface IntegrationTokenState {
  status: string
  tokenExpiresAt: Date | null
  tokenRefreshedAt: Date | null
}

export interface ShopeeTokenStore {
  getState(integrationId: number, companyId: number): Promise<IntegrationTokenState | null>
  readTokens(integrationId: number, companyId: number): Promise<{ accessToken: string | null; refreshToken: string | null }>
  claim(integrationId: number, companyId: number, workerId: string, leaseSeconds: number): Promise<{ claimed: boolean; state: IntegrationTokenState | null }>
  complete(integrationId: number, companyId: number, workerId: string, tokens: ShopeeTokens): Promise<boolean>
  fail(integrationId: number, companyId: number, workerId: string, needsReauth: boolean, error: string | null): Promise<void>
}

export interface GetAccessTokenInput {
  integrationId: number
  companyId: number
  store: ShopeeTokenStore
  /** Troca refresh_token por par novo (produção: oauth.refreshTokens com o shop_id da integração). */
  refresh: (refreshToken: string) => Promise<ShopeeTokens>
  /** Força refresh se o token corrente ainda for o que o chamador viu (identificado pelo expires_at). */
  forceIfExpiresAt?: Date | null
  workerId?: string
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  waitMs?: number
}

export interface AccessTokenResult {
  accessToken: string
  expiresAt: Date | null
  refreshed: boolean
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function needsRefresh(state: IntegrationTokenState, now: Date, forceIfExpiresAt: Date | null | undefined): boolean {
  if (!state.tokenExpiresAt) return true
  if (forceIfExpiresAt !== undefined && forceIfExpiresAt !== null
      && state.tokenExpiresAt.getTime() === forceIfExpiresAt.getTime()) return true
  return state.tokenExpiresAt.getTime() - now.getTime() < TOKEN_EXPIRY_SKEW_MS
}

function assertUsable(state: IntegrationTokenState | null): asserts state is IntegrationTokenState {
  if (!state) throw new ShopeeError('integration_not_found', 'Integração Shopee não encontrada.')
  if (state.status === 'needs_reauth') throw new ShopeeError('reauth_required', 'A conexão com a Shopee precisa ser reautorizada.')
  if (state.status === 'inactive') throw new ShopeeError('integration_disabled', 'A integração Shopee está desconectada.')
  if (state.status !== 'active' && state.status !== 'error') {
    throw new ShopeeError('integration_disabled', `Integração Shopee em estado ${state.status}.`)
  }
}

export async function getValidAccessToken(input: GetAccessTokenInput): Promise<AccessTokenResult> {
  const now = input.now ?? (() => new Date())
  const sleep = input.sleep ?? defaultSleep
  const workerId = input.workerId ?? `token-${randomUUID()}`
  const deadline = now().getTime() + (input.waitMs ?? REFRESH_WAIT_MS)
  const { integrationId, companyId, store } = input
  let waited = false

  for (;;) {
    const state = await store.getState(integrationId, companyId)
    assertUsable(state)

    if (!needsRefresh(state, now(), input.forceIfExpiresAt)) {
      const { accessToken } = await store.readTokens(integrationId, companyId)
      if (accessToken) return { accessToken, expiresAt: state.tokenExpiresAt, refreshed: false }
    }

    const claim = await store.claim(integrationId, companyId, workerId, REFRESH_LEASE_SECONDS)
    if (claim.claimed) {
      return await refreshAsOwner({ ...input, workerId, now }, claim.state)
    }

    if (!waited) {
      waited = true
      logShopee('shopee.token.refresh_waited', { company_id: companyId, integration_id: integrationId, worker_id: workerId })
    }
    if (now().getTime() >= deadline) {
      throw new ShopeeError('refresh_in_progress', 'Renovação de token da Shopee em andamento em outro processo. Tente novamente.')
    }
    if (input.forceIfExpiresAt && claim.state?.tokenExpiresAt
        && claim.state.tokenExpiresAt.getTime() !== input.forceIfExpiresAt.getTime()) {
      input = { ...input, forceIfExpiresAt: undefined }
    }
    await sleep(REFRESH_POLL_MS)
  }
}

async function refreshAsOwner(
  input: GetAccessTokenInput & { workerId: string; now: () => Date },
  claimedState: IntegrationTokenState | null,
): Promise<AccessTokenResult> {
  const { integrationId, companyId, store, workerId } = input

  if (claimedState && !needsRefresh(claimedState, input.now(), input.forceIfExpiresAt)) {
    const { accessToken } = await store.readTokens(integrationId, companyId)
    if (accessToken) {
      await store.fail(integrationId, companyId, workerId, false, null) // só libera o lease
      return { accessToken, expiresAt: claimedState.tokenExpiresAt, refreshed: false }
    }
  }

  const { refreshToken } = await store.readTokens(integrationId, companyId)
  if (!refreshToken) {
    await store.fail(integrationId, companyId, workerId, true, 'refresh_token ausente')
    logShopee('shopee.token.refresh_failed', { company_id: companyId, integration_id: integrationId, worker_id: workerId, reason: 'missing_refresh_token' })
    throw new ShopeeError('reauth_required', 'Sem refresh_token armazenado — reautorize a loja Shopee.')
  }

  let tokens: ShopeeTokens
  try {
    tokens = await input.refresh(refreshToken)
  } catch (err) {
    const e = isShopeeError(err) ? err : new ShopeeError('network', 'Falha inesperada ao renovar token.')
    const reauth = e.kind === 'reauth_required'
    await store.fail(integrationId, companyId, workerId, reauth, `${e.kind}${e.shopeeError ? `:${e.shopeeError}` : ''}`)
    logShopee('shopee.token.refresh_failed', {
      company_id: companyId, integration_id: integrationId, worker_id: workerId,
      http_status: e.httpStatus, request_id: e.requestId, reason: reauth ? 'needs_reauth' : e.kind,
    })
    throw e
  }

  const persisted = await store.complete(integrationId, companyId, workerId, tokens)
  if (!persisted) {
    logShopee('shopee.token.refresh_failed', { company_id: companyId, integration_id: integrationId, worker_id: workerId, reason: 'lease_lost' })
    return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, refreshed: true }
  }
  logShopee('shopee.token.refreshed', { company_id: companyId, integration_id: integrationId, worker_id: workerId, shop_id: tokens.shopId })
  return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, refreshed: true }
}

// ─── Store de produção (Supabase / RPCs genéricas) ─────────────────────────

function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null
}

function parseState(row: { status?: string; credential_expires_at?: string | null; credential_refreshed_at?: string | null } | null): IntegrationTokenState | null {
  if (!row || !row.status || row.status === 'not_found') return null
  return { status: row.status, tokenExpiresAt: toDate(row.credential_expires_at), tokenRefreshedAt: toDate(row.credential_refreshed_at) }
}

export function createSupabaseShopeeTokenStore(): ShopeeTokenStore {
  const admin = createAdminClient() as any

  return {
    async getState(integrationId, companyId) {
      const { data, error } = await admin
        .from('company_integrations')
        .select('status, credential_expires_at, credential_refreshed_at')
        .eq('id', integrationId)
        .eq('company_id', companyId)
        .eq('provider', SHOPEE_PROVIDER)
        .maybeSingle()
      if (error) throw new ShopeeError('network', 'Falha ao ler integração Shopee.')
      return parseState(data)
    },

    async readTokens(integrationId, companyId) {
      const [access, refresh] = await Promise.all([
        getIntegrationSecret(integrationId, companyId, 'access_token'),
        getIntegrationSecret(integrationId, companyId, 'refresh_token'),
      ])
      if (!access.ok || !refresh.ok) throw new ShopeeError('network', 'Falha ao ler credenciais cifradas da integração.')
      return { accessToken: access.data, refreshToken: refresh.data }
    },

    async claim(integrationId, companyId, workerId, leaseSeconds) {
      const { data, error } = await admin.rpc('rpc_claim_integration_token_refresh', {
        p_integration_id: integrationId, p_company_id: companyId, p_worker_id: workerId, p_lease_seconds: leaseSeconds,
      })
      if (error) throw new ShopeeError('network', 'Falha ao adquirir lease de refresh.')
      return { claimed: Boolean(data?.claimed), state: parseState(data) }
    },

    async complete(integrationId, companyId, workerId, tokens) {
      const access = encryptSecret(tokens.accessToken)
      const refresh = encryptSecret(tokens.refreshToken)
      const { data, error } = await admin.rpc('rpc_complete_integration_token_refresh', {
        p_integration_id: integrationId,
        p_company_id: companyId,
        p_worker_id: workerId,
        p_access_ciphertext: access.ciphertext,
        p_refresh_ciphertext: refresh.ciphertext,
        p_key_version: access.keyVersion,
        p_credential_expires_at: tokens.expiresAt.toISOString(),
        p_oauth_scopes: null,
      })
      if (error) throw new ShopeeError('network', 'Falha ao gravar tokens renovados.')
      return data === true
    },

    async fail(integrationId, companyId, workerId, needsReauth, errorText) {
      await admin.rpc('rpc_fail_integration_token_refresh', {
        p_integration_id: integrationId, p_company_id: companyId, p_worker_id: workerId,
        p_needs_reauth: needsReauth, p_error: errorText,
      })
    },
  }
}
