export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { logError } from '@/lib/errors/log'
import { validateStockForSale, validateProductsActive, checkSalePrices, createSale } from '@/services/vendas.service'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const itemSchema = z.object({
  product_variation_id: z.number().int().positive(),
  quantity:             z.number().int().positive(),
  unit_price:           z.number().positive(),
  unit_cost:            z.number().min(0),
  discount_amount:      z.number().min(0).default(0),
})

const schema = z.object({
  customer_id:      z.number().int().positive(),
  payment_method:   z.enum(['pix', 'card', 'cash']),
  delivery_mode:    z.enum(['pickup', 'delivery']).default('delivery'),
  sale_origin:      z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  discount_amount:  z.number().min(0).default(0),
  surcharge_amount: z.number().min(0).default(0),
  cashback_used:    z.number().min(0).default(0),
  shipping_charged: z.number().min(0).default(0),
  notes:            z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  items:            z.array(itemSchema).min(1),
})

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  try {
    // Regra 1: produtos/variações devem estar ativos (hard block para qualquer role)
    const activeCheck = await validateProductsActive(parsed.data.items, user.company_id)
    if (!activeCheck.ok) return NextResponse.json({ error: activeCheck.error }, { status: activeCheck.status })

    // Regra 2: validar estoque disponível
    const stockCheck = await validateStockForSale(parsed.data.items, user.company_id)
    if (!stockCheck.ok) return NextResponse.json({ error: stockCheck.error }, { status: stockCheck.status })

    // Regra 3: preço abaixo do custo — bloqueia usuario, avisa gerente/admin
    const priceCheck = checkSalePrices(parsed.data.items)
    if (priceCheck.warnings.length > 0 && user.role === 'usuario') {
      return NextResponse.json(
        { error: `Venda com margem negativa requer aprovação de gerente. ${priceCheck.warnings[0]}` },
        { status: 403 }
      )
    }

    // Criar venda via service (sale + itens + estoque + finance)
    const result = await createSale({ ...parsed.data, systemUserId: user.id })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    const sale = result.data
    auditLog({
      userId: user.id, userRole: user.role,
      action: 'create', resource: 'sale',
      resourceId: sale.id, detail: sale.sale_number,
    })

    // Criar envio automaticamente após a venda
    const { delivery_mode } = parsed.data
    const shipmentStatus = delivery_mode === 'pickup' ? 'aguardando_retirada' : 'aguardando_confirmacao'
    const admin = createAdminClient()
    await (admin as any)
      .from('shipments')
      .insert({
        order_id:      sale.id,
        customer_id:   parsed.data.customer_id,
        delivery_mode,
        status:        shipmentStatus,
        notes:         parsed.data.notes ?? null,
        company_id:    user.company_id,
      })
    // Erro no shipment é não-fatal: a venda já foi criada

    return NextResponse.json({
      sale,
      ...(priceCheck.warnings.length > 0 ? { warnings: priceCheck.warnings } : {}),
    })
  } catch (err) {
    logError({
      route: 'POST /api/vendas',
      err,
      context: {
        user_id:     user.id,
        company_id:  user.company_id,
        items_count: parsed.data.items.length,
        customer_id: parsed.data.customer_id,
      },
    })
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
