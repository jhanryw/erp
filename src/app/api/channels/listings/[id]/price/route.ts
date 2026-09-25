export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auditLog } from '@/lib/audit/log'
import { toListingView, updateListingPrice } from '@/services/channels/listings.service'
import { channelErrorResponse, parsePositiveId, requireChannelUser } from '../../../_shared'
import { zodErrorMessage } from '@/app/api/produtos/kits/schema'

const bodySchema = z.object({ price: z.coerce.number().positive().max(1_000_000) })

/**
 * POST /api/channels/listings/{id}/price — preço próprio DESTA oferta.
 * Só vira sucesso depois da confirmação do canal; não altera preço-base,
 * outras ofertas, Nuvemshop ou PDV.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  const listingId = parsePositiveId(params.id)
  if (!listingId) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: zodErrorMessage(parsed.error) }, { status: 422 })
  try {
    const r = await updateListingPrice(user.company_id, listingId, parsed.data.price, user.id)
    auditLog({
      userId: user.id, userRole: user.role, action: 'update', resource: 'product', resourceId: r.row.product_id,
      detail: `oferta ${listingId} (${r.row.offer_key}): preço ${parsed.data.price} → ${r.result}`,
    })
    return NextResponse.json({ result: r.result, message: r.message, listing: toListingView(r.row) }, { status: r.result === 'applied' ? 200 : 409 })
  } catch (err) {
    return channelErrorResponse(err)
  }
}
