export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { runPeriodicListingReconcile } from '@/services/channels/listingsReconcile.service'

/**
 * Job: reconciliação periódica canal → Qarvon dos anúncios vivos. SOMENTE
 * LEITURA no canal (nenhum preço/estoque/status é enviado). Mesma
 * autenticação de /api/jobs/* (Authorization: Bearer <CRON_SECRET>).
 *
 * Agendar a cada 15 minutos. Cada anúncio é lido no máximo 1× a cada
 * CHANNEL_RECONCILE_MIN_AGE_MINUTES (padrão 60) e cada execução processa até
 * CHANNEL_RECONCILE_BATCH_SIZE anúncios (padrão 100 → 5 leituras em lote de 20).
 */
const envInt = (name: string, fallback: number) => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const result = await runPeriodicListingReconcile({
      limit: Math.min(envInt('CHANNEL_RECONCILE_BATCH_SIZE', 100), 500),
      minAgeSeconds: envInt('CHANNEL_RECONCILE_MIN_AGE_MINUTES', 60) * 60,
    })
    const summary = {
      claimed: result.claimed, reconciled: result.reconciled, changed: result.changed,
      failed: result.failed, skipped_concurrent: result.skipped_concurrent,
    }
    if (result.errors.length) console.error('[jobs/channels/reconcile] com erros', { errors: result.errors.slice(0, 10) })
    console.log('[jobs/channels/reconcile]', summary)
    return NextResponse.json({ ok: true, ...summary })
  } catch (err) {
    console.error('[jobs/channels/reconcile] falhou', { error: err instanceof Error ? err.message : 'erro' })
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
