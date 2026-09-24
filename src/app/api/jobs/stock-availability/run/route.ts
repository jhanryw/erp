/**
 * Job: consome a fila `stock_availability_changes` e atualiza o cache
 * derivado `variation_availability` (kits recalculados quando um componente
 * muda, vendável ↔ indisponível detectado). Mesma autenticação de
 * `/api/jobs/*` (`Authorization: Bearer <CRON_SECRET>`), já coberta por
 * PUBLIC_PATHS no middleware.
 *
 * A disponibilidade exibida no PDV/telas é SEMPRE calculada ao vivo — este
 * job não é necessário para vender corretamente; ele mantém o cache e é o
 * consumidor de stock.changed para os canais (Fase 3): variações alteradas
 * → Nuvemshop; anúncios marcados stock_sync_pending → Mercado Livre.
 */

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { runStockChannelFanout } from '@/services/channels/stockFanout.service'

const BATCH_SIZE = (() => {
  const n = Number(process.env.STOCK_AVAILABILITY_BATCH_SIZE)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500
})()

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workerId = `cron-${randomUUID()}`
  const result = await runStockChannelFanout(workerId, Math.max(1, Math.floor(BATCH_SIZE / 5)))

  if (result.errors.length > 0) {
    console.error('[jobs/stock-availability/run] com erros', { worker_id: workerId, errors: result.errors.slice(0, 10) })
  }
  console.log('[jobs/stock-availability/run]', {
    worker_id: workerId, changed: result.changedVariations, nuvemshop: result.nuvemshopPushed,
    listings_synced: result.listingsSynced, listings_failed: result.listingsFailed,
  })
  return NextResponse.json({ ok: result.errors.length === 0, worker_id: workerId, ...result, errors: result.errors.length })
}
