export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { estimateListingOfferFee } from '@/services/channels/listings.service'
import { channelErrorResponse, parsePositiveId, requireChannelUser } from '../../../_shared'

/** GET ?price= — tarifa ESTIMADA desta oferta (pré-venda; nunca entra no financeiro). */
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  const listingId = parsePositiveId(params.id)
  if (!listingId) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  const raw = request.nextUrl.searchParams.get('price')
  const price = raw == null || raw === '' ? null : Number(raw)
  if (price != null && !(price > 0 && price <= 1_000_000)) return NextResponse.json({ error: 'Preço inválido.' }, { status: 400 })
  try {
    return NextResponse.json({ estimate: await estimateListingOfferFee(user.company_id, listingId, price) })
  } catch (err) {
    return channelErrorResponse(err)
  }
}
