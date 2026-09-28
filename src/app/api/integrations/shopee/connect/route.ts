export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { startShopeeOAuth } from '@/services/integrations/shopee.service'
import { isShopeeError } from '@/lib/integrations/shopee/errors'
import { integrationPageLocation, requireIntegrationAdmin, safeRedirect } from '../_shared'

/**
 * GET /api/integrations/shopee/connect — inicia a autorização de uma loja.
 * Empresa e usuário vêm da SESSÃO e ficam vinculados ao state (hash no banco).
 * Serve também para reautorizar uma loja em needs_reauth e para conectar
 * lojas adicionais.
 */
export async function GET(_request: Request) {
  const { user, response } = await requireIntegrationAdmin()
  if (response) return response

  try {
    const { authorizationUrl } = await startShopeeOAuth({ userId: user.id, companyId: user.company_id })
    const res = NextResponse.redirect(authorizationUrl, { status: 303 })
    res.headers.set('Cache-Control', 'no-store')
    return res
  } catch (err) {
    const reason = isShopeeError(err) ? err.kind : 'internal'
    return safeRedirect(integrationPageLocation({ shopee: 'error', reason }))
  }
}
