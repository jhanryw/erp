/**
 * Job: consome a fila `stock_availability_changes` e atualiza o cache
 * derivado `variation_availability` (kits recalculados quando um componente
 * muda, vendável ↔ indisponível detectado). Mesma autenticação de
 * `/api/jobs/*` (`Authorization: Bearer <CRON_SECRET>`), já coberta por
 * PUBLIC_PATHS no middleware.
 *
 * A disponibilidade exibida no PDV/telas é SEMPRE calculada ao vivo — este
 * job não é necessário para vender corretamente; ele mantém o cache que o
 * futuro Marketplace Hub usará para saber o que mudou e publicar nos canais.
 */

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { processStockAvailabilityChanges } from '@/services/inventory/availability.service'

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
  const result = await processStockAvailabilityChanges(BATCH_SIZE, workerId)

  if (!result.ok) {
    console.error('[jobs/stock-availability/run] falhou', { worker_id: workerId, error: result.error })
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 })
  }

  console.log('[jobs/stock-availability/run]', { worker_id: workerId, ...result.data })
  return NextResponse.json({ ok: true, worker_id: workerId, ...result.data })
}
