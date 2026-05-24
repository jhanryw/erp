export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { cancelCashMovement } from '@/services/caixa.service'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  movement_id:          z.number().int().positive(),
  cancellation_reason:  z.string().min(1),
})

// POST /api/caixa/movimentos/cancelar
export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const result = await cancelCashMovement(parsed.data.movement_id, user.id, parsed.data.cancellation_reason)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ cancelled: result.data })
}
