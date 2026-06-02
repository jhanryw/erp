export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { addCashMovement } from '@/services/caixa.service'
import { auditLog } from '@/lib/audit/log'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  session_id:        z.number().int().positive(),
  type:              z.enum(['sangria', 'suprimento', 'expense']),
  amount:            z.number().positive(),
  description:       z.string().min(1),
  method:            z.enum(['cash', 'pix', 'credit_card', 'debit_card']).default('cash'),
  reference_sale_id: z.number().int().positive().optional().nullable(),
  metadata:          z.record(z.unknown()).default({}),
})

// POST /api/caixa/movimentos
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

  const result = await addCashMovement({
    sessionId:       parsed.data.session_id,
    userId:          user.id,
    type:            parsed.data.type,
    amount:          parsed.data.amount,
    description:     parsed.data.description,
    method:          parsed.data.method,
    referenceSaleId: parsed.data.reference_sale_id ?? null,
    metadata:        parsed.data.metadata,
  })

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'add_movement', resource: 'cash_movement',
    resourceId: result.data.id,
    after: {
      type:        parsed.data.type,
      method:      parsed.data.method,
      amount:      parsed.data.amount,
      description: parsed.data.description,
      session_id:  parsed.data.session_id,
    },
  })

  return NextResponse.json({ movement: result.data }, { status: 201 })
}
