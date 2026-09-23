export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { auditLog } from '@/lib/audit/log'
import { getChannelProductOverview, publishListings } from '@/services/channels/listings.service'
import { getMercadoLivreConnection } from '@/services/integrations/mercadolivre.service'
import { requiredAttributeIdsFor } from '@/services/channels/mercadolivreChannel'
import { channelErrorResponse, parsePositiveId, requireChannelUser } from '../_shared'
import { publishListingsSchema } from './schema'
import { zodErrorMessage } from '@/app/api/produtos/kits/schema'

/** GET ?product_id= — "Canais de venda" do produto: conexão + variações + anúncios. */
export async function GET(request: NextRequest) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  const productId = parsePositiveId(request.nextUrl.searchParams.get('product_id'))
  if (!productId) return NextResponse.json({ error: 'product_id obrigatório.' }, { status: 400 })
  try {
    const [connection, overview] = await Promise.all([
      getMercadoLivreConnection(user.company_id),
      getChannelProductOverview(user.company_id, productId),
    ])
    return NextResponse.json({
      channels: { mercadolivre: { state: connection.state, nickname: connection.nickname, site_id: connection.site_id, is_test_user: connection.is_test_user } },
      ...overview,
    })
  } catch (err) {
    return channelErrorResponse(err)
  }
}

/** POST — publica variações selecionadas (idempotente por variação × conta). */
export async function POST(request: Request) {
  const { user, response } = await requireChannelUser()
  if (response) return response

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }
  const parsed = publishListingsSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: zodErrorMessage(parsed.error) }, { status: 422 })
  const b = parsed.data

  try {
    // Obrigatórios calculados no servidor a partir da categoria (+ condicionais).
    const requiredAttributeIds = await requiredAttributeIdsFor(user.company_id, b.category_id, [
      ...b.common_attributes, ...(b.variations[0]?.attributes ?? []),
    ])
    const { channel, results } = await publishListings(
      { companyId: user.company_id, userId: user.id },
      {
        productId: b.product_id,
        categoryId: b.category_id,
        listingTypeId: b.listing_type_id,
        familyName: b.family_name ?? null,
        description: b.description ?? null,
        commonAttributes: b.common_attributes,
        requiredAttributeIds,
        variations: b.variations.map((v) => ({ productVariationId: v.product_variation_id, channelPrice: v.channel_price ?? null, attributes: v.attributes })),
      },
    )
    const published = results.filter((r) => r.status === 'published' || r.status === 'reconciled')
    auditLog({
      userId: user.id, userRole: user.role, action: 'create', resource: 'product', resourceId: b.product_id,
      detail: `mercadolivre: ${published.length}/${results.length} variação(ões) publicada(s) (conta ${channel.accountLabel ?? channel.sellerId}${channel.isTestAccount ? ', TEST' : ''})`,
    })
    return NextResponse.json({ model: channel.model, results }, { status: published.length > 0 ? 201 : 200 })
  } catch (err) {
    return channelErrorResponse(err)
  }
}
