export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { reconcileListing } from '@/services/channels/listings.service'
import { channelErrorResponse, parsePositiveId, requireChannelUser } from '../../../_shared'

/** POST /api/channels/listings/{id}/reconcile — vincula anúncio criado no canal cuja gravação local falhou (busca por seller_sku). */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  const listingId = parsePositiveId(params.id)
  if (!listingId) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  try {
    const result = await reconcileListing(user.company_id, listingId)
    return NextResponse.json({ result })
  } catch (err) {
    return channelErrorResponse(err)
  }
}
