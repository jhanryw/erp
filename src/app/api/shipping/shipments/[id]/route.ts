export const dynamic = 'force-dynamic'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const patchSchema = z.object({
  status: z.enum([
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
  ]),
})

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const shipmentId = Number(params.id)
  if (!shipmentId || isNaN(shipmentId)) {
    return NextResponse.json({ error: 'ID inválido.' }, { status: 400 })
  }

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = createAdminClient()

  // Garantir que o envio pertence à empresa do usuário
  const { data: existing } = await (admin as any)
    .from('shipments')
    .select('id, company_id')
    .eq('id', shipmentId)
    .single() as unknown as { data: { id: number; company_id: number } | null }

  if (!existing) return NextResponse.json({ error: 'Envio não encontrado.' }, { status: 404 })
  if (existing.company_id !== user.company_id) return NextResponse.json({ error: 'Acesso negado.' }, { status: 403 })

  const { data, error } = await (admin as any)
    .from('shipments')
    .update({ status: parsed.data.status, updated_at: new Date().toISOString() })
    .eq('id', shipmentId)
    .select('id, status')
    .single() as unknown as { data: any; error: any }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ shipment: data })
}
