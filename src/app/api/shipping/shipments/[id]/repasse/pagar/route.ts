export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) {
    return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  }

  const shipmentId = Number(params.id)
  if (!shipmentId || isNaN(shipmentId)) {
    return NextResponse.json({ error: 'ID de envio inválido.' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data, error } = await (admin as any)
    .rpc('rpc_pagar_repasse_motoboy', {
      p_shipment_id:    shipmentId,
      p_system_user_id: user.id,
    }) as unknown as {
      data: {
        shipment_id:      number
        finance_entry_id: number
        repasse_amount:   number
        sale_number:      string
        repasse_paid_at:  string
      } | null
      error: { code: string; message: string } | null
    }

  if (error) {
    const status = error.code === 'P0001' ? 400 : 500
    return NextResponse.json({ error: error.message }, { status })
  }

  return NextResponse.json({ ok: true, repasse: data }, { status: 200 })
}
