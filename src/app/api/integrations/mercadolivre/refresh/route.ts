export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { forceRefreshMercadoLivreToken } from '@/services/integrations/mercadolivre.service'
import { errorResponse, requireIntegrationAdmin } from '../_shared'

/**
 * POST — força a renovação do token (homologação/diagnóstico). Passa pelo
 * mesmo lease do refresh automático; nunca devolve o token.
 */
export async function POST() {
  const { user, response } = await requireIntegrationAdmin()
  if (response) return response
  try {
    return NextResponse.json({ connection: await forceRefreshMercadoLivreToken(user.company_id) })
  } catch (err) {
    return errorResponse(err)
  }
}
