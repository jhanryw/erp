/**
 * Access token válido para uma integração — com refresh seguro sob
 * concorrência.
 *
 * O refresh_token do Mercado Livre é de USO ÚNICO e só o último emitido vale.
 * Dois processos usando o mesmo refresh_token = o segundo recebe
 * invalid_grant e a conta cairia em "reautorizar" à toa. Por isso:
 *
 *   1. lê estado (status + credential_expires_at). Token ainda válido (com margem
 *      de 5 min) → devolve o access_token decifrado. Fim.
 *   2. expirado → tenta o LEASE da integração (rpc_claim_integration_token_refresh,
 *      UPDATE atômico). Só um worker ganha.
 *   3. quem ganhou: confere de novo (outro pode ter renovado entre a leitura
 *      e o claim) → relê o refresh_token ATUAL → POST /oauth/token →
 *      grava o par novo + expires_at + libera o lease na MESMA transação,
 *      só se ainda for o dono (fencing: rpc_complete_integration_token_refresh).
 *   4. quem perdeu: espera (poll curto) até o vencedor gravar e reutiliza o
 *      token NOVO — nunca usa o refresh_token que o outro já rotacionou.
 *   5. invalid_grant → status needs_reauth, lease liberado, sem retry.
 *      Falha transitória → lease liberado, status mantido, erro tipado
 *      `retryable` para a camada de cima.
 *
 * O armazenamento é uma interface (TokenStore): produção usa as RPCs do
 * Supabase (createSupabaseTokenStore); os testes usam um store em memória
 * com a mesma semântica de lease para simular workers concorrentes.
 */

import { randomUUID } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { encryptSecret } from '@/lib/security/secretCipher'
import { getIntegrationSecret } from '@/services/integrations/secrets.service'
import { MercadoLivreError, isMercadoLivreError } from './errors'
import { logMercadoLivre } from './log'
import type { MercadoLivreTokens } from './types'

export const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000
export const REFRESH_LEASE_SECONDS = 60
export const REFRESH_WAIT_MS = 20_000
export const REFRESH_POLL_MS = 250

export interface IntegrationTokenState {
  status: string
  tokenExpiresAt: Date | null
  tokenRefreshedAt: Date | null
}

export interface TokenStore {
  getState(integrationId: number, companyId: number): Promise<IntegrationTokenState | null>
  readTokens(integrationId: number, companyId: number): Promise<{ accessToken: string | null; refreshToken: string | null }>
  claim(integrationId: number, companyId: number, workerId: string, leaseSeconds: number): Promise<{ claimed: boolean; state: IntegrationTokenState | null }>
  complete(integrationId: number, companyId: number, workerId: string, tokens: MercadoLivreTokens): Promise<boolean>
  fail(integrationId: number, companyId: number, workerId: string, needsReauth: boolean, error: string | null): Promise<void>
}

export interface GetAccessTokenInput {
  integrationId: number
  companyId: number
  store: TokenStore
  /** Troca refresh_token por par novo (produção: oauth.refreshTokens). */
  refresh: (refreshToken: string) => Promise<MercadoLivreTokens>
  /**
   * Força refresh SE o token corrente ainda for o mesmo que o chamador usou
   * (identificado pelo expires_at dele). Usado após 401: se outro processo já
   * renovou, reaproveita o novo em vez de renovar de novo.
   */
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
  if (!state) throw new MercadoLivreError('integration_not_found', 'Integração Mercado Livre não encontrada.')
  if (state.status === 'needs_reauth') throw new MercadoLivreError('reauth_required', 'A conexão com o Mercado Livre precisa ser reautorizada.')
  if (state.status === 'inactive') throw new MercadoLivreError('integration_disabled', 'A integração Mercado Livre está desconectada.')
  if (state.status !== 'active' && state.status !== 'error') {
    throw new MercadoLivreError('integration_disabled', `Integração Mercado Livre em estado ${state.status}.`)
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

    // Outro worker está renovando: espera e relê (no próximo giro o token
    // novo, gravado pelo vencedor, passa em needsRefresh=false).
    if (!waited) {
      waited = true
      logMercadoLivre('mercadolivre.token.refresh_waited', { company_id: companyId, integration_id: integrationId, worker_id: workerId })
    }
    if (now().getTime() >= deadline) {
      throw new MercadoLivreError('refresh_in_progress', 'Renovação de token do Mercado Livre em andamento em outro processo. Tente novamente.')
    }
    // Um "force" só vale para o token que o chamador viu; se já mudou, não força de novo.
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

  // Double-check sob lease: outro worker pode ter renovado entre a leitura e o claim.
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
    logMercadoLivre('mercadolivre.token.refresh_failed', { company_id: companyId, integration_id: integrationId, worker_id: workerId, reason: 'missing_refresh_token' })
    throw new MercadoLivreError('reauth_required', 'Sem refresh_token armazenado — reautorize a conta Mercado Livre.')
  }

  let tokens: MercadoLivreTokens
  try {
    tokens = await input.refresh(refreshToken)
  } catch (err) {
    const mlErr = isMercadoLivreError(err) ? err : new MercadoLivreError('network', 'Falha inesperada ao renovar token.')
    const reauth = mlErr.kind === 'reauth_required'
    await store.fail(integrationId, companyId, workerId, reauth, `${mlErr.kind}${mlErr.mlError ? `:${mlErr.mlError}` : ''}`)
    logMercadoLivre('mercadolivre.token.refresh_failed', {
      company_id: companyId, integration_id: integrationId, worker_id: workerId,
      http_status: mlErr.httpStatus, request_id: mlErr.requestId, reason: reauth ? 'needs_reauth' : mlErr.kind,
    })
    throw mlErr
  }

  const persisted = await store.complete(integrationId, companyId, workerId, tokens)
  if (!persisted) {
    // Lease perdido (só ocorre se o refresh demorar mais que o lease — o
    // timeout HTTP de 15s torna isso improvável com lease de 60s). O par
    // novo é válido para esta chamada, mas não é persistido para não
    // sobrescrever o dono atual.
    logMercadoLivre('mercadolivre.token.refresh_failed', { company_id: companyId, integration_id: integrationId, worker_id: workerId, reason: 'lease_lost' })
    return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, refreshed: true }
  }

  logMercadoLivre('mercadolivre.token.refreshed', { company_id: companyId, integration_id: integrationId, worker_id: workerId, seller_id: tokens.userId })
  return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, refreshed: true }
}

// ─── Store de produção (Supabase / RPCs) ─────────────────────────────────────

function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null
}

function parseState(row: { status?: string; credential_expires_at?: string | null; credential_refreshed_at?: string | null } | null): IntegrationTokenState | null {
  if (!row || !row.status || row.status === 'not_found') return null
  return { status: row.status, tokenExpiresAt: toDate(row.credential_expires_at), tokenRefreshedAt: toDate(row.credential_refreshed_at) }
}

export function createSupabaseTokenStore(): TokenStore {
  const admin = createAdminClient() as any

  return {
    async getState(integrationId, companyId) {
      const { data, error } = await admin
        .from('company_integrations')
        .select('status, credential_expires_at, credential_refreshed_at')
        .eq('id', integrationId)
        .eq('company_id', companyId)
        .eq('provider', 'mercadolivre')
        .maybeSingle()
      if (error) throw new MercadoLivreError('network', 'Falha ao ler integração Mercado Livre.')
      return parseState(data)
    },

    async readTokens(integrationId, companyId) {
      const [access, refresh] = await Promise.all([
        getIntegrationSecret(integrationId, companyId, 'access_token'),
        getIntegrationSecret(integrationId, companyId, 'refresh_token'),
      ])
      if (!access.ok || !refresh.ok) throw new MercadoLivreError('network', 'Falha ao ler credenciais cifradas da integração.')
      return { accessToken: access.data, refreshToken: refresh.data }
    },

    async claim(integrationId, companyId, workerId, leaseSeconds) {
      const { data, error } = await admin.rpc('rpc_claim_integration_token_refresh', {
        p_integration_id: integrationId, p_company_id: companyId, p_worker_id: workerId, p_lease_seconds: leaseSeconds,
      })
      if (error) throw new MercadoLivreError('network', 'Falha ao adquirir lease de refresh.')
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
        p_oauth_scopes: tokens.scopes,
      })
      if (error) throw new MercadoLivreError('network', 'Falha ao gravar tokens renovados.')
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
