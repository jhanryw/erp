export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { isVapidConfigured, sendTestPush } from '@/lib/push/send'

export async function POST() {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!isVapidConfigured()) {
    return NextResponse.json({ ok: false, reason: 'VAPID_NOT_CONFIGURED' }, { status: 503 })
  }

  const { subscriptionsFound, sent, statuses } = await sendTestPush({
    userId: user.id,
    title:  'Santtorini',
    body:   'Notificações funcionando neste dispositivo.',
    url:    '/',
  })

  if (subscriptionsFound === 0) {
    return NextResponse.json({ ok: false, reason: 'NO_ACTIVE_SUBSCRIPTION' }, { status: 404 })
  }

  if (sent === 0) {
    const statusCode = statuses.find((s) => s !== null) ?? null
    return NextResponse.json({ ok: false, reason: 'WEB_PUSH_FAILED', statusCode }, { status: 502 })
  }

  return NextResponse.json({
    ok: true,
    subscriptionsFound,
    sent,
    failed: subscriptionsFound - sent,
    statuses,
  })
}
