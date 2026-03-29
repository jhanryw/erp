import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { createStockEntry } from '@/services/estoque.service'
import { NextResponse } from 'next/server'
import { stockLotSchema } from '@/lib/validators'

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  const systemUserId = process.env.SYSTEM_USER_ID
  if (!systemUserId) {
    return NextResponse.json({ error: 'SYSTEM_USER_ID não definido nas variáveis de ambiente.' }, { status: 500 })
  }

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = stockLotSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  const result = await createStockEntry(parsed.data, systemUserId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'create', resource: 'stock_entry',
    resourceId: parsed.data.product_variation_id,
    detail: `lot:${result.data.lot_id} qty:${parsed.data.quantity_original} unit_cost:${result.data.cost_per_unit.toFixed(2)}`,
    after:  { lot_id: result.data.lot_id, new_quantity: result.data.new_quantity, new_avg_cost: result.data.new_avg_cost },
  })
  return NextResponse.json(result.data)
}
