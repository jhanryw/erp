export const dynamic = 'force-dynamic'

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { updateWholesaleOrderStatus } from '@/services/wholesale/ordersAdmin'
import { ORDER_STATUSES } from '@/services/wholesale/orderStatus'

const schema = z.object({ status: z.enum(ORDER_STATUSES) }).strict()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// PATCH /api/pedidos-atacado/[id] — troca o status do pedido (pendente/finalizado/cancelado).
// Autenticado; escopo sempre pela empresa da sessão.
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  if (!UUID.test(params.id)) return NextResponse.json({ error: 'ID inválido.' }, { status: 400 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 }) }
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Status inválido.' }, { status: 422 })

  const updated = await updateWholesaleOrderStatus(createAdminClient() as any, user.company_id, params.id, parsed.data.status)
  if (!updated) return NextResponse.json({ error: 'Pedido não encontrado.' }, { status: 404 })

  auditLog({
    userId: user.id, userRole: user.role, action: 'update', resource: 'wholesale_order',
    resourceId: params.id, after: { wholesale_order_status: parsed.data.status }, detail: 'Status do pedido de atacado',
  })
  return NextResponse.json({ ok: true, status: parsed.data.status })
}
