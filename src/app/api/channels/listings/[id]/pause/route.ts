export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { pauseListing, toListingView } from '@/services/channels/listings.service'
import { channelErrorResponse, parsePositiveId, requireChannelUser } from '../../../_shared'

/** POST /api/channels/listings/{id}/pause — pausa MANUAL (não é desfeita por reposição de estoque). */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  const listingId = parsePositiveId(params.id)
  if (!listingId) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  try {
    const result = await pauseListing(user.company_id, listingId)
    return NextResponse.json({ listing: toListingView(result) })
  } catch (err) {
    return channelErrorResponse(err)
  }
}
