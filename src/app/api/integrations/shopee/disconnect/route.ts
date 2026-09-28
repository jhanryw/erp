export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { auditLog } from '@/lib/audit/log'
import { disconnectShopee } from '@/services/integrations/shopee.service'
import { errorResponse, readIntegrationId, requireIntegrationAdmin } from '../_shared'

/** POST { integration_id } — desconecta uma loja (apaga tokens, preserva o registro). */
export async function POST(request: Request) {
  const { user, response } = await requireIntegrationAdmin()
  if (response) return response
  const integrationId = await readIntegrationId(request)
  if (!integrationId) return NextResponse.json({ error: 'integration_id obrigatório.' }, { status: 400 })
  try {
    const shop = await disconnectShopee(user.company_id, integrationId, user.id)
    auditLog({ userId: user.id, userRole: user.role, action: 'update', resource: 'company_integration', resourceId: shop.integration_id, detail: 'shopee: loja desconectada' })
    return NextResponse.json({ shop })
  } catch (err) {
    return errorResponse(err)
  }
}
