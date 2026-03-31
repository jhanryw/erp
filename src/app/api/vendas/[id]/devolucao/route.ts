import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { returnSale } from '@/services/vendas.service'
import { NextResponse } from 'next/server'

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  const saleId = Number(params.id)

  const result = await returnSale(saleId, user.id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'return', resource: 'sale', resourceId: saleId,
    after: { status: 'returned' },
  })

  return NextResponse.json({ success: true })
}
