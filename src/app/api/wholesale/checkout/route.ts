export const dynamic = 'force-dynamic'

/**
 * POST /api/wholesale/checkout — Fase 8, seção 23 do pedido.
 *
 * 1. resolve tenant (nunca do browser);
 * 2. exige sessão de cliente (getWholesaleCustomerSession);
 * 3. valida corpo (Zod) — nunca aceita sale_type/sales_channel/preço;
 * 4. delega pra checkoutWholesaleCart, que recarrega preço/estoque no
 *    servidor e chama a infraestrutura real de criação de venda.
 */

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { getWholesaleCustomerSession } from '@/lib/wholesale/session'
import { checkoutWholesaleCart } from '@/services/wholesale/checkout'
import { deliveryRecipientSchema } from '@/lib/validators'

const schema = z.object({
  idempotency_key: z.string().uuid(),
  items: z.array(z.object({
    variation_id: z.number().int().positive(),
    quantity: z.number().int().positive(),
  })).min(1),
  delivery_mode: z.enum(['pickup', 'delivery']),
  delivery_recipient: deliveryRecipientSchema.nullable().optional(),
  notes: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().max(500).nullable().optional()),
}).refine(
  (d) => d.delivery_mode !== 'delivery' || d.delivery_recipient != null,
  { message: 'Endereço de entrega obrigatório para pedido com entrega.', path: ['delivery_recipient'] },
)

export async function POST(request: Request) {
  const tenant = await resolveWholesaleSiteTenant()
  if (!tenant) return NextResponse.json({ error: 'Site de atacado não configurado.' }, { status: 503 })

  const session = await getWholesaleCustomerSession()
  if (!session) return NextResponse.json({ error: 'Faça login para concluir o pedido.' }, { status: 401 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const result = await checkoutWholesaleCart({
    customerId: session.customerId,
    companyId: tenant.companyId,
    systemUserId: tenant.systemUserId,
    idempotencyKey: parsed.data.idempotency_key,
    items: parsed.data.items.map((i) => ({ variationId: i.variation_id, quantity: i.quantity })),
    deliveryMode: parsed.data.delivery_mode,
    deliveryRecipient: parsed.data.delivery_recipient
      ? { ...parsed.data.delivery_recipient, uf: parsed.data.delivery_recipient.uf.toUpperCase() }
      : null,
    notes: parsed.data.notes ?? null,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error, unavailable_items: result.unavailableItems }, { status: result.status })
  }

  return NextResponse.json({ sale_id: result.saleId, sale_number: result.saleNumber, total: result.total })
}
