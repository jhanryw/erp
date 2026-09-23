import { NextResponse } from 'next/server'
import { requireSession, type SessionUser } from '@/lib/supabase/session'
import { hasMinRole } from '@/types/roles'
import { isMercadoLivreError } from '@/lib/integrations/mercadolivre/errors'

/**
 * Conectar/reautorizar/desconectar integração = mesmo nível das demais
 * integrações do projeto (Configurações → Nuvemshop/Fiscal exigem admin).
 */
export const MERCADOLIVRE_MIN_ROLE = 'admin' as const

export const INTEGRATION_PAGE_PATH = '/configuracoes/mercadolivre'

export type AdminSession = SessionUser & { company_id: number }

export async function requireIntegrationAdmin(): Promise<
  { user: AdminSession; response: null } | { user: null; response: NextResponse }
> {
  const result = await requireSession()
  if (result.response) return { user: null, response: result.response }
  if (!hasMinRole(result.user.role, MERCADOLIVRE_MIN_ROLE)) {
    return { user: null, response: NextResponse.json({ error: 'Acesso negado. Permissão insuficiente.' }, { status: 403 }) }
  }
  if (!result.user.company_id) {
    return { user: null, response: NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 }) }
  }
  return { user: result.user as AdminSession, response: null }
}

/** Resposta de erro para a UI: só o tipo e uma mensagem já redigida. */
export function errorResponse(err: unknown): NextResponse {
  if (isMercadoLivreError(err)) {
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

/** Redirect que não vaza o callback (com `code`) via Referer. */
export function safeRedirect(url: URL): NextResponse {
  const res = NextResponse.redirect(url, { status: 303 })
  res.headers.set('Referrer-Policy', 'no-referrer')
  res.headers.set('Cache-Control', 'no-store')
  return res
}
