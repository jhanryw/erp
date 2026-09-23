export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { getMercadoLivreConnection } from '@/services/integrations/mercadolivre.service'
import { errorResponse, requireIntegrationAdmin } from '../_shared'

/** GET — estado da conexão da empresa da sessão. Só metadados não sensíveis. */
export async function GET() {
  const { user, response } = await requireIntegrationAdmin()
  if (response) return response
  try {
    return NextResponse.json({ connection: await getMercadoLivreConnection(user.company_id) })
  } catch (err) {
    return errorResponse(err)
  }
}
