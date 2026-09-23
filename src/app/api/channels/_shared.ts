import { NextResponse } from 'next/server'
import { requireRole, type SessionUser } from '@/lib/supabase/session'
import { isMercadoLivreError } from '@/lib/integrations/mercadolivre/errors'
import { ListingError } from '@/services/channels/listings.service'

/** Publicar/sincronizar/pausar anúncios = mesmo nível da publicação na Nuvemshop (gerente). */
export const CHANNEL_MIN_ROLE = 'gerente' as const

export type ChannelSession = SessionUser & { company_id: number }

export async function requireChannelUser(): Promise<
  { user: ChannelSession; response: null } | { user: null; response: NextResponse }
> {
  const { user, response } = await requireRole(CHANNEL_MIN_ROLE)
  if (response) return { user: null, response }
  if (!user.company_id) return { user: null, response: NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 }) }
  return { user: user as ChannelSession, response: null }
}

export function parsePositiveId(raw: string | null): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Erros para a UI: tipo + mensagem já redigida; nunca token/segredo. */
export function channelErrorResponse(err: unknown): NextResponse {
  if (err instanceof ListingError) {
    const status =
      err.code === 'not_found' ? 404 :
      err.code === 'real_account_blocked' ? 403 :
      err.code === 'not_connected' || err.code === 'needs_reauth' ? 409 :
      err.code === 'in_progress' || err.code === 'already_published' || err.code === 'needs_reconciliation' ? 409 :
      422
    return NextResponse.json({ error: err.message, code: err.code }, { status })
  }
  if (isMercadoLivreError(err)) {
    const status = err.kind === 'rate_limited' ? 429 : err.kind === 'reauth_required' ? 409 : err.retryable ? 502 : 400
    return NextResponse.json({ error: err.message, code: err.kind }, { status })
  }
  console.error('[api/channels] erro inesperado', err instanceof Error ? err.message : 'unknown')
  return NextResponse.json({ error: 'Erro interno.' }, { status: 500 })
}
