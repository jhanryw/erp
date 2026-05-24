export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { getOpenSession, openCashSession } from '@/services/caixa.service'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// GET /api/caixa — retorna sessão aberta (ou null)
export async function GET() {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const result = await getOpenSession(user.id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ session: result.data })
}

const openSchema = z.object({
  opening_amount_cash: z.number().min(0).default(0),
  notes:               z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
})

// POST /api/caixa — abre nova sessão de caixa
export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = openSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const result = await openCashSession(user.id, parsed.data.opening_amount_cash, parsed.data.notes)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ session: result.data }, { status: 201 })
}
