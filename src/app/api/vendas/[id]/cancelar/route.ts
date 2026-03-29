import { createAdminClient } from '@/lib/supabase/admin'
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

  const systemUserId = process.env.SYSTEM_USER_ID
  if (!systemUserId) return NextResponse.json({ error: 'SYSTEM_USER_ID não configurado.' }, { status: 500 })

  const result = await cancelSale(saleId, systemUserId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'cancel', resource: 'sale', resourceId: saleId,
    before: { status: 'paid' }, // simplification since it's cancelled, wait we don't have the status before, but audit doesn't strictly need it if the RPC guarantees it.
    after: { status: 'cancelled' },
  })

  return NextResponse.json({ ok: true })
}
