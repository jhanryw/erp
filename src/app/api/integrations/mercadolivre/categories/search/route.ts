export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { searchCategories } from '@/lib/integrations/mercadolivre/catalog'
import { getConnectedMercadoLivreIntegration } from '@/services/channels/mercadolivreChannel'
import { channelErrorResponse, requireChannelUser } from '@/app/api/channels/_shared'

/** GET ?q= — preditor de categoria do ML (domain_discovery), pela conta da empresa. */
export async function GET(request: NextRequest) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  const q = request.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ suggestions: [] })
  try {
    const { integrationId, siteId } = await getConnectedMercadoLivreIntegration(user.company_id)
    const suggestions = await searchCategories({ integrationId, companyId: user.company_id }, siteId, q.slice(0, 120), 5)
    return NextResponse.json({ suggestions })
  } catch (err) {
    return channelErrorResponse(err)
  }
}
