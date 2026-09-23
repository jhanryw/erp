export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { auditLog } from '@/lib/audit/log'
import { disconnectMercadoLivre } from '@/services/integrations/mercadolivre.service'
import { errorResponse, requireIntegrationAdmin } from '../_shared'

/** POST — desconecta (revoga no ML se possível, apaga tokens, preserva o registro). */
export async function POST() {
  const { user, response } = await requireIntegrationAdmin()
  if (response) return response
  try {
    const connection = await disconnectMercadoLivre(user.company_id, user.id)
    auditLog({ userId: user.id, userRole: user.role, action: 'update', resource: 'company_integration', resourceId: connection.integration_id ?? undefined, detail: 'mercadolivre: desconectado' })
    return NextResponse.json({ connection })
  } catch (err) {
    return errorResponse(err)
  }
}
