import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { cancelSale } from '@/services/vendas.service'
import { NextResponse } from 'next/server'

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  const saleId = Number(params.id)

  const result = await cancelSale(saleId, user.id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'cancel', resource: 'sale', resourceId: saleId,
    after: { status: 'cancelled' },
  })

  return NextResponse.json({ ok: true })
}
