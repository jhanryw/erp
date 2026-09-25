export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { estimateOfferFee } from '@/services/channels/listings.service'
import { channelErrorResponse, requireChannelUser } from '@/app/api/channels/_shared'

/** GET ?category_id=&listing_type_id=&price= — tarifa ESTIMADA para uma nova oferta. */
export async function GET(request: NextRequest) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  const q = request.nextUrl.searchParams
  const categoryId = q.get('category_id')?.trim() ?? ''
  const listingTypeId = q.get('listing_type_id')?.trim() ?? ''
  const price = Number(q.get('price'))
  if (!/^[A-Z]{3}\d+$/.test(categoryId) || !/^[a-z0-9_]{2,40}$/.test(listingTypeId) || !(price > 0 && price <= 1_000_000)) {
    return NextResponse.json({ error: 'Parâmetros inválidos.' }, { status: 400 })
  }
  try {
    return NextResponse.json({ estimate: await estimateOfferFee(user.company_id, { price, categoryId, listingTypeId }) })
  } catch (err) {
    return channelErrorResponse(err)
  }
}
