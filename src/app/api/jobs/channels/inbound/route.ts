export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { runInboundCycle } from '@/services/channels/inboundCycle.service'

/**
 * Job: processa inbound_events pendentes (pedidos de marketplace) e roda o
 * fan-out de estoque para os canais. Mesma autenticação de /api/jobs/*
 * (Authorization: Bearer <CRON_SECRET>). Agendar a cada 1 minuto.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const workerId = `cron-${randomUUID()}`
  try {
    const { inbound, fanout } = await runInboundCycle(workerId, { limit: 25, alwaysFanout: true })
    const summary = {
      worker_id: workerId,
      claimed: inbound.claimed, processed: inbound.processed, failed: inbound.failed, dead: inbound.dead,
      stock_changed_variations: fanout?.changedVariations ?? 0, listings_synced: fanout?.listingsSynced ?? 0,
      listings_failed: fanout?.listingsFailed ?? 0,
    }
    console.log('[jobs/channels/inbound]', summary)
    return NextResponse.json({ ok: true, ...summary })
  } catch (err) {
    console.error('[jobs/channels/inbound] falhou', { worker_id: workerId, error: err instanceof Error ? err.message : 'erro' })
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
