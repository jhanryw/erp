export const dynamic = 'force-dynamic'

/**
 * POST /api/jobs/settle-scheduled-payments
 *
 * Gatilho ALTERNATIVO/manual da efetivação de pagamentos agendados. O
 * agendamento oficial é o pg_cron (202611191100), que chama a função SQL
 * direto. Esta rota existe para operação (disparo manual, ou cron externo se
 * pg_cron não estiver disponível). Autenticada por CRON_SECRET, como os
 * demais /api/jobs/*. Toda a regra vive em public.fn_settle_scheduled_payments()
 * (idempotente) — aqui não há lógica de negócio.
 */

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('Authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await (createAdminClient() as any).rpc('fn_settle_scheduled_payments')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}
