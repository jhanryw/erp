import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { logError } from '@/lib/errors/log'
import { cancelSale } from '@/services/vendas.service'
import { NextResponse } from 'next/server'

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  const saleId = Number(params.id)

  try {
    const result = await cancelSale(saleId, user.id)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    auditLog({
      userId: user.id, userRole: user.role,
      action: 'cancel', resource: 'sale', resourceId: saleId,
      after: { status: 'cancelled' },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    logError({
      route: 'POST /api/vendas/[id]/cancelar',
      err,
      context: { user_id: user.id, company_id: user.company_id, sale_id: saleId },
    })
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
