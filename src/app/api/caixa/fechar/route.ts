export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { closeCashSession } from '@/services/caixa.service'
import { auditLog } from '@/lib/audit/log'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  session_id:   z.number().int().positive(),
  counted_cash: z.number().min(0),
  notes:        z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
})

// POST /api/caixa/fechar — restrito a gerente/admin
export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const result = await closeCashSession(parsed.data.session_id, user.id, parsed.data.counted_cash, parsed.data.notes)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'close_cash', resource: 'cash_session',
    resourceId: parsed.data.session_id,
    after: {
      counted_cash:    result.data.counted_cash,
      expected_cash:   result.data.expected_cash,
      cash_difference: result.data.cash_difference,
      total_sales:     result.data.total_sales,
    },
  })

  return NextResponse.json({ summary: result.data })
}
