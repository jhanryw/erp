export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { syncListing, toListingView } from '@/services/channels/listings.service'
import { channelErrorResponse, parsePositiveId, requireChannelUser } from '../../../_shared'

/** POST /api/channels/listings/{id}/sync — sincroniza quantidade (camada central) e preço com o canal. */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  const listingId = parsePositiveId(params.id)
  if (!listingId) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  try {
    const result = await syncListing(user.company_id, listingId)
    return NextResponse.json({ listing: toListingView(result) })
  } catch (err) {
    return channelErrorResponse(err)
  }
}
