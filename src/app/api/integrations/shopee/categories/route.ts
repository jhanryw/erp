export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { listShopeeCategories } from '@/services/channels/shopeeChannel'
import { channelErrorResponse, parsePositiveId, requireChannelUser } from '@/app/api/channels/_shared'

/**
 * GET ?integration_id=&parent_id=&q= — categorias da loja Shopee (get_category,
 * ao vivo, sem cache). parent_id=root → só raízes. A empresa vem da sessão;
 * integration_id de outra empresa → 409 (não conectada).
 */
export async function GET(request: NextRequest) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  const sp = request.nextUrl.searchParams
  const integrationId = parsePositiveId(sp.get('integration_id'))
  if (!integrationId) return NextResponse.json({ error: 'integration_id obrigatório.' }, { status: 400 })
  const rawParent = sp.get('parent_id')
  const parentId = rawParent == null ? undefined : rawParent === 'root' ? null : parsePositiveId(rawParent)
  if (parentId === null && rawParent !== 'root') return NextResponse.json({ error: 'parent_id inválido.' }, { status: 400 })
  try {
    const categories = await listShopeeCategories(user.company_id, integrationId, { parentId, q: sp.get('q')?.slice(0, 120) ?? null })
    return NextResponse.json({ categories })
  } catch (err) {
    return channelErrorResponse(err)
  }
}
