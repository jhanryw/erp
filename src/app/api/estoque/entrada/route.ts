import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { stockLotSchema } from '@/lib/validators'

export async function POST(request: Request) {
  const body = await request.json()
  const parsed = stockLotSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const {
    product_variation_id,
    supplier_id,
    entry_type,
    quantity_original,
    unit_cost,
    freight_cost = 0,
    tax_cost = 0,
    entry_date,
    notes,
  } = parsed.data

  const total_lot_cost = unit_cost * quantity_original + freight_cost + tax_cost
  const cost_per_unit = total_lot_cost / quantity_original

  const admin = createAdminClient()

  // 1. Inserir lote de estoque
  const { data: lot, error: lotError } = await admin
    .from('stock_lots')
    .insert({
      product_variation_id,
      supplier_id: supplier_id ?? null,
      entry_type,
      quantity_original,
      quantity_remaining: quantity_original,
      unit_cost,
      freight_cost,
      tax_cost,
      total_lot_cost,
      cost_per_unit,
      entry_date,
      notes: notes ?? null,
    } as any)
    .select()
    .single() as unknown as { data: { id: string } | null, error: any }

  if (lotError) {
    return NextResponse.json({ error: lotError.message }, { status: 500 })
  }

  // 2. Atualizar estoque (upsert) com média ponderada de custo (WACC)
  const { data: currentStock } = await admin
    .from('stock')
    .select('quantity, avg_cost')
    .eq('product_variation_id', product_variation_id)
    .single() as unknown as { data: { quantity: number, avg_cost: number } | null, error: any }

  const prevQty = currentStock?.quantity ?? 0
  const prevAvgCost = currentStock?.avg_cost ?? 0
  const newQty = prevQty + quantity_original
  const newAvgCost =
    newQty > 0
      ? (prevQty * prevAvgCost + quantity_original * cost_per_unit) / newQty
      : cost_per_unit

  const { error: stockError } = await admin.from('stock').upsert(
    {
      product_variation_id,
      quantity: newQty,
      avg_cost: newAvgCost,
      last_updated: new Date().toISOString(),
    } as any,
    { onConflict: 'product_variation_id' }
  )

  if (stockError) {
    return NextResponse.json({ error: stockError.message }, { status: 500 })
  }

  // 3. Registrar lançamento financeiro (despesa de compra de estoque)
  await admin.from('finance_entries').insert({
    type: 'expense',
    category: 'stock_purchase',
    description: `Entrada de estoque — Lote #${lot!.id}`,
    amount: total_lot_cost,
    reference_date: entry_date,
    stock_lot_id: lot!.id,
  } as any)

  return NextResponse.json({
    lot_id: lot!.id,
    new_quantity: newQty,
    new_avg_cost: newAvgCost,
    total_lot_cost,
    cost_per_unit,
  })
}
