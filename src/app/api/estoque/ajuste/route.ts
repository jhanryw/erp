import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { adjustStock } from '@/services/estoque.service'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  product_variation_id: z.number().min(1),
  delta:  z.number().int().refine((n) => n !== 0, { message: 'Delta não pode ser zero' }),
  reason: z.string().min(1),
  notes:  z.string().optional(),
})

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const result = await adjustStock(parsed.data, user.id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'adjust', resource: 'stock_adjustment',
    resourceId: parsed.data.product_variation_id,
    detail: `delta:${parsed.data.delta} reason:${parsed.data.reason}`,
    after:  { new_quantity: result.data.new_quantity, delta: result.data.delta },
  })
  return NextResponse.json(result.data)
}
