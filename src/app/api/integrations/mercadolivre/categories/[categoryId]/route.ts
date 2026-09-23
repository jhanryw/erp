export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getMercadoLivrePublishForm } from '@/services/channels/mercadolivreChannel'
import { channelErrorResponse, parsePositiveId, requireChannelUser } from '@/app/api/channels/_shared'

/**
 * GET /api/integrations/mercadolivre/categories/{id}?product_id= — detalhe da
 * categoria + atributos dinâmicos (comuns × por variação) + sugestões de
 * valores a partir do produto da empresa da sessão.
 */
export async function GET(request: NextRequest, { params }: { params: { categoryId: string } }) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  const categoryId = params.categoryId?.trim()
  if (!categoryId || !/^[A-Z]{3}\d+$/.test(categoryId)) {
    return NextResponse.json({ error: 'Categoria inválida.' }, { status: 400 })
  }
  const productId = parsePositiveId(request.nextUrl.searchParams.get('product_id'))
  try {
    return NextResponse.json(await getMercadoLivrePublishForm(user.company_id, categoryId, productId))
  } catch (err) {
    return channelErrorResponse(err)
  }
}
