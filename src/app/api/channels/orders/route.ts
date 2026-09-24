export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { listChannelOrders } from '@/services/channels/channelOrders.service'
import { requireChannelUser } from '../_shared'

const STATES = new Set(['pending', 'awaiting_payment', 'needs_attention', 'imported', 'cancelled', 'ignored'])

/** GET ?state= — pedidos de marketplace da empresa da sessão. */
export async function GET(request: NextRequest) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  const state = request.nextUrl.searchParams.get('state')
  if (state && !STATES.has(state)) return NextResponse.json({ error: 'Estado inválido.' }, { status: 400 })
  try {
    return NextResponse.json({ orders: await listChannelOrders(user.company_id, state) })
  } catch {
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 })
  }
}
