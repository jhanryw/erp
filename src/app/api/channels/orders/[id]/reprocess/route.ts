export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { ChannelOrderError, reprocessChannelOrder } from '@/services/channels/channelOrders.service'
import { runStockChannelFanout } from '@/services/channels/stockFanout.service'
import { channelErrorResponse, parsePositiveId, requireChannelUser } from '../../../_shared'

/**
 * POST /api/channels/orders/{id}/reprocess — relê o pedido no canal e tenta
 * de novo (ex.: needs_attention depois de repor estoque ou vincular o SKU).
 * Idempotente: pedido já importado só sincroniza custos.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  const id = parsePositiveId(params.id)
  if (!id) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  try {
    const result = await reprocessChannelOrder(user.company_id, id)
    if (result.action === 'imported' || result.action === 'cancelled') {
      await runStockChannelFanout(`reprocess-${randomUUID()}`).catch(() => undefined)
    }
    return NextResponse.json({ result })
  } catch (err) {
    if (err instanceof ChannelOrderError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.code === 'not_found' ? 404 : 422 })
    }
    return channelErrorResponse(err)
  }
}
