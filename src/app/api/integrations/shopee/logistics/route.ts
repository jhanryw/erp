export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getShopeeLogistics } from '@/services/channels/shopeeChannel'
import { usableLogisticsChannels } from '@/lib/integrations/shopee/catalog'
import { channelErrorResponse, parsePositiveId, requireChannelUser } from '@/app/api/channels/_shared'

/** GET ?integration_id= — canais logísticos da loja (get_channel_list), só leitura. */
export async function GET(request: NextRequest) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  const integrationId = parsePositiveId(request.nextUrl.searchParams.get('integration_id'))
  if (!integrationId) return NextResponse.json({ error: 'integration_id obrigatório.' }, { status: 400 })
  try {
    const channels = await getShopeeLogistics(user.company_id, integrationId)
    const usable = usableLogisticsChannels(channels)
    return NextResponse.json({ channels, usable_channel_ids: usable.map((c) => c.logistics_channel_id), default_channel_id: usable[0]?.logistics_channel_id ?? null })
  } catch (err) {
    return channelErrorResponse(err)
  }
}
