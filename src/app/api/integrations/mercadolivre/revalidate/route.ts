export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { revalidateMercadoLivreConnection } from '@/services/integrations/mercadolivre.service'
import { errorResponse, requireIntegrationAdmin } from '../_shared'

/** POST — revalida a conexão (GET /users/me com o token da integração). */
export async function POST() {
  const { user, response } = await requireIntegrationAdmin()
  if (response) return response
  try {
    return NextResponse.json({ connection: await revalidateMercadoLivreConnection(user.company_id) })
  } catch (err) {
    return errorResponse(err)
  }
}
