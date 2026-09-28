export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { getShopeeConnections } from '@/services/integrations/shopee.service'
import { errorResponse, requireIntegrationAdmin } from '../_shared'

/** GET — lojas Shopee da empresa da sessão. Só metadados não sensíveis. */
export async function GET() {
  const { user, response } = await requireIntegrationAdmin()
  if (response) return response
  try {
    return NextResponse.json({ connection: await getShopeeConnections(user.company_id) })
  } catch (err) {
    return errorResponse(err)
  }
}
