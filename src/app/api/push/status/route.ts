export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { isVapidConfigured } from '@/lib/push/send'

export async function GET() {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  const admin = createAdminClient()

  const { data: lastSub } = await (admin as any)
    .from('push_subscriptions')
    .select('created_at, endpoint')
    .eq('user_id', user.id)
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: lastLog } = await (admin as any)
    .from('push_send_logs')
    .select('sent_at, success, status_code, error_message')
    .eq('user_id', user.id)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return NextResponse.json({
    // VAPID backend/runtime: as 3 envs lidas pelo servidor (send.ts) — não
    // diz nada sobre o que foi inlinado no bundle do cliente no build.
    vapidBackendConfigured: isVapidConfigured(),
    lastRegisteredAt:       lastSub?.created_at ?? null,
    lastPushAt:             lastLog?.sent_at ?? null,
    lastStatus:             lastLog ? (lastLog.success ? (lastLog.status_code ?? 201) : `Erro ${lastLog.status_code ?? ''}`.trim()) : null,
    lastError:              lastLog && !lastLog.success ? (lastLog.error_message ?? null) : null,
  })
}
