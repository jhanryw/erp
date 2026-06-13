export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  shipment_ids:      z.array(z.number().int().positive()).min(1, 'Selecione ao menos um envio.'),
  force_no_motoboy:  z.boolean().default(false),
})

export async function POST(req: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) {
    return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  }

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const admin = createAdminClient()

  const { data, error } = await (admin as any)
    .rpc('rpc_pagar_repasse_lote', {
      p_shipment_ids:     parsed.data.shipment_ids,
      p_system_user_id:   user.id,
      p_force_no_motoboy: parsed.data.force_no_motoboy,
    }) as unknown as {
      data: {
        needs_confirmation?:        boolean
        shipments_without_motoboy?: number[]
        count_without_motoboy?:     number
        message?:                   string
        batch_id?:                  number
        total_amount?:              number
        shipment_count?:            number
        entries?:                   unknown[]
      } | null
      error: { code: string; message: string } | null
    }

  if (error) {
    const status = error.code === 'P0001' ? 400 : 500
    return NextResponse.json({ error: error.message }, { status })
  }

  if (data?.needs_confirmation) {
    return NextResponse.json(
      {
        needs_confirmation:        true,
        shipments_without_motoboy: data.shipments_without_motoboy,
        count_without_motoboy:     data.count_without_motoboy,
        message:                   data.message,
      },
      { status: 409 }
    )
  }

  return NextResponse.json({ ok: true, batch: data }, { status: 200 })
}
