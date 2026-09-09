export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { isVapidConfigured, sendTestPush } from '@/lib/push/send'

export async function POST() {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!isVapidConfigured()) {
    return NextResponse.json({ error: 'VAPID não configurada no servidor.' }, { status: 503 })
  }

  const { sent, total } = await sendTestPush({
    userId: user.id,
    title:  'Santtorini',
    body:   'Notificações funcionando neste dispositivo.',
    url:    '/',
  })

  if (total === 0) {
    return NextResponse.json({ error: 'Nenhuma assinatura ativa encontrada para este usuário.' }, { status: 404 })
  }

  return NextResponse.json({ ok: true, sent, total })
}
