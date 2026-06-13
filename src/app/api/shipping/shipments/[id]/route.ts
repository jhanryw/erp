export const dynamic = 'force-dynamic'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const VALID_STATUSES = [
  'aguardando_confirmacao',
  'aguardando_separacao',
  'pronto_envio',
  'aguardando_motoboy',
  'saiu_entrega',
  'entregue',
  'nao_entregue',
  'aguardando_retirada',
  'retirado',
  'cancelado',
] as const

const patchSchema = z.object({
  status:             z.enum(VALID_STATUSES).optional(),
  internal_cost_real: z.number().positive('Custo real deve ser maior que zero.').nullable().optional(),
  repasse_amount:     z.number().positive('Valor do repasse deve ser maior que zero.').nullable().optional(),
  motoboy:            z.string().max(100).nullable().optional(),
  courier_phone:      z.string().max(20).nullable().optional(),
  notes:              z.string().max(500).nullable().optional(),
})

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) {
    return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  }

  const shipmentId = Number(params.id)
  if (!shipmentId || isNaN(shipmentId)) {
    return NextResponse.json({ error: 'ID inválido.' }, { status: 400 })
  }

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const admin = createAdminClient()

  // Busca o estado atual para aplicar regras de negócio
  const { data: current } = await (admin as any)
    .from('shipments')
    .select('id, company_id, delivery_mode, repasse_status, repasse_finance_entry_id')
    .eq('id', shipmentId)
    .single() as unknown as {
      data: {
        id: number
        company_id: number
        delivery_mode: string
        repasse_status: string
        repasse_finance_entry_id: number | null
      } | null
    }

  if (!current) return NextResponse.json({ error: 'Envio não encontrado.' }, { status: 404 })
  if (current.company_id !== user.company_id) return NextResponse.json({ error: 'Acesso negado.' }, { status: 403 })

  // Regras para campos de repasse
  const isChangingRepasse =
    parsed.data.internal_cost_real !== undefined ||
    parsed.data.repasse_amount !== undefined

  if (isChangingRepasse) {
    if (current.delivery_mode === 'pickup') {
      return NextResponse.json(
        { error: 'Retirada (pickup) não tem repasse ao motoboy.' },
        { status: 400 }
      )
    }
    if (current.repasse_status === 'paid' || current.repasse_finance_entry_id != null) {
      return NextResponse.json(
        { error: 'Repasse já pago. O valor não pode ser alterado após o lançamento.' },
        { status: 400 }
      )
    }
  }

  // Monta payload apenas com campos fornecidos
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (parsed.data.status             !== undefined) updates.status             = parsed.data.status
  if (parsed.data.internal_cost_real !== undefined) updates.internal_cost_real = parsed.data.internal_cost_real
  if (parsed.data.repasse_amount     !== undefined) updates.repasse_amount     = parsed.data.repasse_amount
  if (parsed.data.motoboy            !== undefined) updates.motoboy            = parsed.data.motoboy
  if (parsed.data.courier_phone      !== undefined) updates.courier_phone      = parsed.data.courier_phone
  if (parsed.data.notes              !== undefined) updates.notes              = parsed.data.notes

  if (Object.keys(updates).length === 1) {
    return NextResponse.json({ error: 'Nenhum campo fornecido para atualização.' }, { status: 400 })
  }

  const { data, error } = await (admin as any)
    .from('shipments')
    .update(updates)
    .eq('id', shipmentId)
    .select('id, status, motoboy, courier_phone, notes, internal_cost_real, repasse_amount, repasse_status')
    .single() as unknown as { data: any; error: any }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ shipment: data })
}
