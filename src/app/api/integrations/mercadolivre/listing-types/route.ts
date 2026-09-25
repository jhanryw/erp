export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getMercadoLivreListingTypes } from '@/services/channels/mercadolivreChannel'
import { channelErrorResponse, requireChannelUser } from '@/app/api/channels/_shared'

/** GET ?category_id= — tipos de anúncio disponíveis para a conta nesta categoria. */
export async function GET(request: NextRequest) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  const categoryId = request.nextUrl.searchParams.get('category_id')?.trim() ?? ''
  if (!/^[A-Z]{3}\d+$/.test(categoryId)) return NextResponse.json({ error: 'Categoria inválida.' }, { status: 400 })
  try {
    return NextResponse.json({ listing_types: await getMercadoLivreListingTypes(user.company_id, categoryId) })
  } catch (err) {
    return channelErrorResponse(err)
  }
}
