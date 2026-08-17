/**
 * Runner de cron pro ciclo integration_outbox → deliveries → consumers
 * (Fase 5). Autenticação idêntica ao padrão já usado em `/api/jobs/*`
 * (`refresh-views`, `cashback-expire`, `cashback-release`) — `Authorization:
 * Bearer <CRON_SECRET>`, nunca sessão de usuário, nunca secret em query
 * string. Já coberta por `PUBLIC_PATHS` (prefixo `/api/jobs/`) — não
 * precisou de alteração no middleware.
 *
 * Rota fina por desenho: toda a lógica vive em
 * `src/lib/integrations/runner.ts` — aqui só autenticação + chamada +
 * log de observabilidade seguro (seção 14 do pedido: só contadores/IDs
 * técnicos, nunca token/telefone/email/payload).
 */

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { runIntegrationOutboxCycle } from '@/lib/integrations/runner'

export async function POST(request: Request) {
  const authHeader = request.headers.get('Authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workerId = `cron-${randomUUID()}`
  const result = await runIntegrationOutboxCycle(workerId)

  if (!result.ok) {
    console.error('[jobs/integrations/run] falhou', { worker_id: workerId, error: result.error, partial: result.partial })
    return NextResponse.json({ ok: false, error: result.error, partial: result.partial }, { status: 500 })
  }

  // Observabilidade segura — só contadores numéricos e o worker_id técnico,
  // nunca payload/token/PII (seção 14 do pedido).
  console.log('[jobs/integrations/run]', { worker_id: workerId, ...result.data })

  return NextResponse.json({ ok: true, worker_id: workerId, ...result.data })
}
