import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { z } from 'zod'

if (!SYSTEM_USER_ID) {
  throw new Error('SYSTEM_USER_ID não definido nas variáveis de ambiente.')
}

const schema = z.object({
  product_variation_id: z.number().min(1),
  delta: z.number().int().refine((n) => n !== 0, { message: 'Delta não pode ser zero' }),
  reason: z.string().min(1),
  notes: z.string().optional(),
})

export async function POST(request: Request) {
  const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID

  if (!SYSTEM_USER_ID) {
    return NextResponse.json(
      { error: 'SYSTEM_USER_ID não definido nas variáveis de ambiente.' },
      { status: 500 }
    )
  }

  const { product_variation_id, delta, reason, notes } = parsed.data
  const admin = createAdminClient()

  const { data: current } = await admin
    .from('stock')
    .select('quantity, avg_cost')
    .eq('product_variation_id', product_variation_id)
    .single() as unknown as { data: { quantity: number; avg_cost: number } | null }

  const currentQty = current?.quantity ?? 0
  const newQty = currentQty + delta

  if (newQty < 0) {
    return NextResponse.json(
      { error: `Estoque insuficiente. Atual: ${currentQty}, Ajuste: ${delta}` },
      { status: 400 }
    )
  }

  const { error: stockError } = await admin.from('stock').upsert(
    {
      product_variation_id,
      quantity: newQty,
      avg_cost: current?.avg_cost ?? 0,
      last_updated: new Date().toISOString(),
    } as any,
    { onConflict: 'product_variation_id' }
  )

  if (stockError) {
    return NextResponse.json({ error: stockError.message }, { status: 500 })
  }

  // Log loss to finance_entries
if (delta < 0) {
  const { error: financeError } = await admin.from('finance_entries').insert({
    type: 'expense',
    category: 'other_expense',
    description: `Ajuste de estoque (${reason}): ${Math.abs(delta)} un. — var. #${product_variation_id}`,
    amount: parseFloat((Math.abs(delta) * (current?.avg_cost ?? 0)).toFixed(2)),
    reference_date: new Date().toISOString().slice(0, 10),
    notes: notes ?? null,
    created_by: SYSTEM_USER_ID,
  } as any)

  if (financeError) {
    return NextResponse.json(
      { error: financeError.message },
      { status: 500 }
    )
  }
}

return NextResponse.json({
  new_quantity: newQty,
  previous_quantity: currentQty,
  delta,
})