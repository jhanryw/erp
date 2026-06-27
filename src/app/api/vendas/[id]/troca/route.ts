import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { createSale } from '@/services/vendas.service'
import { auditLog } from '@/lib/audit/log'
import { logError } from '@/lib/errors/log'

const returnedItemSchema = z.object({
  sale_item_id:      z.coerce.number().int().positive(),
  quantity_returned: z.coerce.number().int().min(1),
})

const newItemSchema = z.object({
  product_variation_id: z.coerce.number().int().positive(),
  quantity:             z.coerce.number().int().min(1),
  unit_price:           z.coerce.number().min(0),
})

const schema = z.object({
  customer_id:    z.coerce.number().int().positive(),
  items:          z.array(returnedItemSchema).min(1),
  new_items:      z.array(newItemSchema).optional().default([]),
  payment_method: z.enum(['cash', 'pix', 'credit_card', 'debit_card']).optional(),
  notes:          z.string().max(500).optional(),
})

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth
  if (!user.company_id) {
    return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  }

  const saleId = Number(params.id)
  if (!saleId) return NextResponse.json({ error: 'ID de venda inválido.' }, { status: 400 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { customer_id, items, new_items, payment_method, notes } = parsed.data
  const admin = createAdminClient()

  // ── 1. Processar a troca (devolução + crédito) ──────────────
  const { data: exchangeData, error: exchangeError } = await (admin as any).rpc(
    'rpc_process_exchange',
    {
      p_company_id:  user.company_id,
      p_sale_id:     saleId,
      p_customer_id: customer_id,
      p_items:       items,
      p_notes:       notes ?? null,
      p_user_id:     user.id,
    },
  ) as {
    data: { exchange_id: number; credit_amount: number } | null
    error: { code: string; message: string } | null
  }

  if (exchangeError) {
    const status = exchangeError.code === 'P0001' ? 400 : 500
    return NextResponse.json({ error: exchangeError.message }, { status })
  }

  const creditAmount = exchangeData?.credit_amount ?? 0
  let newSaleId: number | null = null
  let newSaleNumber: string | null = null

  // ── 2. Se tem itens novos → criar venda usando o crédito ────
  if (new_items.length > 0) {
    const newTotal = new_items.reduce((s, i) => s + i.quantity * i.unit_price, 0)
    const cashbackToUse = Math.min(creditAmount, Math.round(newTotal * 100) / 100)
    const remaining = Math.max(0, Math.round((newTotal - cashbackToUse) * 100) / 100)

    // Requer forma de pagamento se ainda tem valor a cobrar
    if (remaining > 0.009 && !payment_method) {
      return NextResponse.json(
        { error: 'Forma de pagamento obrigatória para cobrar a diferença.' },
        { status: 422 },
      )
    }

    try {
      const saleResult = await createSale({
        customer_id,
        systemUserId:      user.id,
        payment_method:    remaining > 0.009 ? (payment_method ?? 'cash') : 'pix',
        sale_origin:       null,
        discount_amount:   0,
        surcharge_amount:  0,
        cashback_used:     cashbackToUse,
        cashback_action:   cashbackToUse > 0 ? 'use' : undefined,
        shipping_charged:  0,
        notes:             notes
          ? `Troca — Venda #${saleId}. ${notes}`
          : `Troca — Venda #${saleId}`,
        items: new_items.map(i => ({
          product_variation_id: i.product_variation_id,
          quantity:             i.quantity,
          unit_price:           i.unit_price,
          unit_cost:            0,   // custo resolvido pelo RPC via stock.avg_cost
          discount_amount:      0,
        })),
        responsible_seller_id: null, // Fase 2 adicionará seleção via AuthorizationModal
      })

      if (saleResult.ok) {
        newSaleId     = saleResult.data!.id
        newSaleNumber = saleResult.data!.sale_number
      }
    } catch (err) {
      logError({
        route:   'POST /api/vendas/[id]/troca — nova venda',
        err,
        context: { user_id: user.id, exchange_id: exchangeData?.exchange_id },
      })
      // A troca foi processada — crédito gerado. Informa que a venda falhou.
      return NextResponse.json({
        ok:            true,
        exchange_id:   exchangeData?.exchange_id,
        credit_amount: creditAmount,
        new_sale_error: 'Troca registrada mas não foi possível criar a nova venda. Use o crédito na próxima compra.',
      })
    }
  }

  auditLog({
    userId: user.id, userRole: user.role,
    action:     'exchange',
    resource:   'sale',
    resourceId: saleId,
    after: {
      exchange_id:    exchangeData?.exchange_id,
      credit_amount:  creditAmount,
      items_returned: items.length,
      new_sale_id:    newSaleId,
    },
  })

  return NextResponse.json({
    ok:             true,
    exchange_id:    exchangeData?.exchange_id,
    credit_amount:  creditAmount,
    new_sale_id:    newSaleId,
    new_sale_number: newSaleNumber,
  })
}
