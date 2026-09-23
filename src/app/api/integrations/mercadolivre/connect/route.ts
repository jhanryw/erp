export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { startMercadoLivreOAuth } from '@/services/integrations/mercadolivre.service'
import { isMercadoLivreError } from '@/lib/integrations/mercadolivre/errors'
import { INTEGRATION_PAGE_PATH, requireIntegrationAdmin, safeRedirect } from '../_shared'

/**
 * GET /api/integrations/mercadolivre/connect — inicia o OAuth.
 * Empresa e usuário vêm da SESSÃO e ficam vinculados ao state (nunca na
 * redirect_uri, que é fixa). Serve também para reautorizar.
 */
export async function GET(request: Request) {
  const { user, response } = await requireIntegrationAdmin()
  if (response) return response

  try {
    const { authorizationUrl } = await startMercadoLivreOAuth({ userId: user.id, companyId: user.company_id })
    const res = NextResponse.redirect(authorizationUrl, { status: 303 })
    res.headers.set('Cache-Control', 'no-store')
    return res
  } catch (err) {
    const reason = isMercadoLivreError(err) ? err.kind : 'internal'
    return safeRedirect(new URL(`${INTEGRATION_PAGE_PATH}?ml=error&reason=${reason}`, request.url))
  }
}
