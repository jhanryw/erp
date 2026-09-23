/**
 * Job: renova proativamente tokens Mercado Livre que expiram na próxima
 * hora (access_token dura 6h). Mantém a conta ativa (o ML invalida grants
 * sem uso por 4 meses) e evita que uma requisição de usuário pague o custo
 * do refresh. Mesma autenticação de /api/jobs/* (Bearer CRON_SECRET).
 * Sugestão de agenda: a cada 30 minutos.
 */

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { refreshExpiringMercadoLivreTokens } from '@/services/integrations/mercadolivre.service'
import { isMercadoLivreError } from '@/lib/integrations/mercadolivre/errors'

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workerId = `cron-ml-${randomUUID()}`
  try {
    const result = await refreshExpiringMercadoLivreTokens({ workerId })
    console.info('[jobs/mercadolivre/refresh-tokens]', JSON.stringify({ worker_id: workerId, ...result }))
    return NextResponse.json({ ok: true, worker_id: workerId, ...result })
  } catch (err) {
    const kind = isMercadoLivreError(err) ? err.kind : 'internal'
    console.error('[jobs/mercadolivre/refresh-tokens] falhou', JSON.stringify({ worker_id: workerId, kind }))
    return NextResponse.json({ ok: false, kind }, { status: kind === 'config' ? 503 : 500 })
  }
}
