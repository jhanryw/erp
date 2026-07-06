export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'

const schema = z.object({
  endpoint:   z.string().url(),
  p256dh:     z.string().min(1),
  auth:       z.string().min(1),
  user_agent: z.string().optional(),
})

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) {
    return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  }

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const admin = createAdminClient()

  // Upsert por endpoint — mesmo dispositivo reconectado atualiza a assinatura
  const { error } = await (admin as any)
    .from('push_subscriptions')
    .upsert(
      {
        user_id:      user.id,
        company_id:   user.company_id,
        role:         user.role,
        endpoint:     parsed.data.endpoint,
        p256dh:       parsed.data.p256dh,
        auth:         parsed.data.auth,
        user_agent:   parsed.data.user_agent ?? null,
        active:       true,
        updated_at:   new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' }
    )

  if (error) {
    console.error('[POST /api/push/subscribe]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
