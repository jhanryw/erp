export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const itemSchema = z.object({
  product_variation_id: z.number().int().positive(),
  quantity: z.number().int().positive(),
  unit_price: z.number().positive(),
  unit_cost: z.number().min(0),
  discount_amount: z.number().min(0).default(0),
})

const schema = z.object({
  customer_id: z.number().int().positive(),
  payment_method: z.enum(['pix', 'card', 'cash']),
  sale_origin: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  discount_amount: z.number().min(0).default(0),
  cashback_used: z.number().min(0).default(0),
  shipping_charged: z.number().min(0).default(0),
  notes: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  items: z.array(itemSchema).min(1),
})

export async function POST(request: Request) {
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const systemUserId = process.env.SYSTEM_USER_ID
  if (!systemUserId) return NextResponse.json({ error: 'SYSTEM_USER_ID não configurado.' }, { status: 500 })

  const { customer_id, payment_method, sale_origin, discount_amount, cashback_used, shipping_charged, notes, items } = parsed.data
  const admin = createAdminClient()

  // Verificar estoque
  for (const item of items) {
    const { data: stock } = (await admin.from('stock').select('quantity').eq('product_variation_id', item.product_variation_id).maybeSingle()) as unknown as { data: { quantity: number } | null }
    if ((stock?.quantity ?? 0) < item.quantity) {
      return NextResponse.json({ error: `Estoque insuficiente para variação #${item.product_variation_id}. Disponível: ${stock?.quantity ?? 0}` }, { status: 400 })
    }
  }

  const subtotal = items.reduce((s, i) => s + i.unit_price * i.quantity - i.discount_amount, 0)
  const total = Math.max(0, subtotal - discount_amount - cashback_used + shipping_charged)

  // Inserir venda
  const { data: sale, error: saleError } = (await admin
    .from('sales')
    .insert({
      customer_id,
      seller_id: systemUserId,
      status: 'paid',
      subtotal: parseFloat(subtotal.toFixed(2)),
      discount_amount,
      cashback_used,
      shipping_charged,
      total: parseFloat(total.toFixed(2)),
      payment_method,
      sale_origin: sale_origin ?? null,
      notes: notes ?? null,
      sale_date: new Date().toISOString().split('T')[0],
    } as any)
    .select('id, sale_number')
    .single()) as unknown as { data: { id: number; sale_number: string } | null; error: any }

  if (saleError || !sale) return NextResponse.json({ error: saleError?.message ?? 'Erro ao criar venda' }, { status: 500 })

  // Inserir itens + debitar estoque
  for (const item of items) {
    await admin.from('sale_items').insert({
      sale_id: sale.id,
      product_variation_id: item.product_variation_id,
      quantity: item.quantity,
      unit_price: item.unit_price,
      unit_cost: item.unit_cost,
      discount_amount: item.discount_amount,
      total_price: parseFloat((item.unit_price * item.quantity - item.discount_amount).toFixed(2)),
    } as any)

    const { data: currentStock } = (await admin.from('stock').select('quantity').eq('product_variation_id', item.product_variation_id).single()) as unknown as { data: { quantity: number } | null }
    await (admin as any).from('stock').update({ quantity: (currentStock?.quantity ?? 0) - item.quantity, last_updated: new Date().toISOString() }).eq('product_variation_id', item.product_variation_id)
  }

  // Lançamento financeiro
  await admin.from('finance_entries').insert({
    type: 'income',
    category: 'sale',
    description: `Venda ${sale.sale_number}`,
    amount: parseFloat(total.toFixed(2)),
    reference_date: new Date().toISOString().split('T')[0],
    sale_id: sale.id,
    created_by: systemUserId,
  } as any)

  return NextResponse.json({ sale })
}
