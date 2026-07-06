export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'

const schema = z.object({
  endpoint: z.string().url(),
})

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const admin = createAdminClient()

  await (admin as any)
    .from('push_subscriptions')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('endpoint', parsed.data.endpoint)
    .eq('user_id', user.id)

  return NextResponse.json({ ok: true })
}
