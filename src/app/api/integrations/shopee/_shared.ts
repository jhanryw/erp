import { NextResponse } from 'next/server'
import { requireSession, type SessionUser } from '@/lib/supabase/session'
import { hasMinRole } from '@/types/roles'
import { isShopeeError } from '@/lib/integrations/shopee/errors'
import { publicAppUrl } from '@/lib/app/publicOrigin'

/** Mesmo nível das demais integrações (Mercado Livre/Nuvemshop/Fiscal): admin. */
export const SHOPEE_MIN_ROLE = 'admin' as const

export const INTEGRATION_PAGE_PATH = '/configuracoes/shopee'

export type AdminSession = SessionUser & { company_id: number }

export async function requireIntegrationAdmin(): Promise<
  { user: AdminSession; response: null } | { user: null; response: NextResponse }
> {
  const result = await requireSession()
  if (result.response) return { user: null, response: result.response }
  if (!hasMinRole(result.user.role, SHOPEE_MIN_ROLE)) {
    return { user: null, response: NextResponse.json({ error: 'Acesso negado. Permissão insuficiente.' }, { status: 403 }) }
  }
  if (!result.user.company_id) {
    return { user: null, response: NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 }) }
  }
  return { user: result.user as AdminSession, response: null }
}

/** Resposta de erro para a UI: só o tipo e uma mensagem já redigida. */
export function errorResponse(err: unknown): NextResponse {
  if (isShopeeError(err)) {
    const status =
      err.kind === 'reauth_required' ? 409 :
      err.kind === 'integration_disabled' || err.kind === 'integration_not_found' ? 404 :
      err.kind === 'config' ? 503 :
      err.kind === 'rate_limited' ? 429 :
      err.retryable ? 502 : 400
    return NextResponse.json({ error: err.message, kind: err.kind }, { status })
  }
  return NextResponse.json({ error: 'Erro interno.' }, { status: 500 })
}

/** Lê `integration_id` do corpo JSON (identifica QUAL loja; a empresa vem sempre da sessão). */
export async function readIntegrationId(request: Request): Promise<number | null> {
  try {
    const body = (await request.json()) as { integration_id?: unknown }
    const id = Number(body?.integration_id)
    return Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

export function integrationPageLocation(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString()
  return publicAppUrl(`${INTEGRATION_PAGE_PATH}${query ? `?${query}` : ''}`)
}

/** Redirect 303 que não vaza o callback (com `code`) via Referer. */
export function safeRedirect(location: string): NextResponse {
  const res = new NextResponse(null, { status: 303 })
  res.headers.set('Location', location)
  res.headers.set('Referrer-Policy', 'no-referrer')
  res.headers.set('Cache-Control', 'no-store')
  return res
}
