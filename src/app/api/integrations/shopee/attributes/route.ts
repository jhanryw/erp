export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getShopeeCategoryAttributes } from '@/services/channels/shopeeChannel'
import { channelErrorResponse, parsePositiveId, requireChannelUser } from '@/app/api/channels/_shared'

/** GET ?integration_id=&category_id= — atributos da categoria (get_attribute_tree): obrigatório/opcional, tipo, valores permitidos, unidade. */
export async function GET(request: NextRequest) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  const sp = request.nextUrl.searchParams
  const integrationId = parsePositiveId(sp.get('integration_id'))
  const categoryId = parsePositiveId(sp.get('category_id'))
  if (!integrationId || !categoryId) return NextResponse.json({ error: 'integration_id e category_id obrigatórios.' }, { status: 400 })
  try {
    return NextResponse.json(await getShopeeCategoryAttributes(user.company_id, integrationId, categoryId))
  } catch (err) {
    return channelErrorResponse(err)
  }
}
