export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { reopenCashSession } from '@/services/caixa.service'
import { auditLog } from '@/lib/audit/log'
import { logError } from '@/lib/errors/log'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  session_id: z.number().int().positive(),
  reason:     z.string().min(1, 'Motivo obrigatório'),
})

// POST /api/caixa/reabrir — restrito a admin
export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  try {
    const result = await reopenCashSession(parsed.data.session_id, user.id, parsed.data.reason)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    auditLog({
      userId: user.id, userRole: user.role,
      action: 'reopen_cash', resource: 'cash_session',
      resourceId: parsed.data.session_id,
      detail: parsed.data.reason,
    })

    return NextResponse.json({ session: result.data })
  } catch (err) {
    logError({
      route: 'POST /api/caixa/reabrir',
      err,
      context: { user_id: user.id, session_id: parsed.data.session_id },
    })
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
