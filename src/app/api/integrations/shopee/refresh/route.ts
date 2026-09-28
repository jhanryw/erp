export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { forceRefreshShopeeToken } from '@/services/integrations/shopee.service'
import { errorResponse, readIntegrationId, requireIntegrationAdmin } from '../_shared'

/**
 * POST { integration_id } — força a renovação do token de uma loja da
 * empresa da sessão. Passa pelo mesmo lease do refresh automático; nunca
 * devolve o token.
 */
export async function POST(request: Request) {
  const { user, response } = await requireIntegrationAdmin()
  if (response) return response
  const integrationId = await readIntegrationId(request)
  if (!integrationId) return NextResponse.json({ error: 'integration_id obrigatório.' }, { status: 400 })
  try {
    return NextResponse.json({ shop: await forceRefreshShopeeToken(user.company_id, integrationId) })
  } catch (err) {
    return errorResponse(err)
  }
}
