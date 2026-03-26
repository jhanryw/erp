import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { stockLotSchema } from '@/lib/validators'

type StockRow = {
  quantity: number | null
  avg_cost: number | null
}

type LotRow = {
  id: string
}

export async function POST(request: Request) {
  const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID

  if (!SYSTEM_USER_ID) {
    return NextResponse.json(
      { error: 'SYSTEM_USER_ID não definido nas variáveis de ambiente.' },
      { status: 500 }
    )
  }

  try {
    const body = await request.json()
    const parsed = stockLotSchema.safeParse(body)

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 }
      )
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

    const lotRes = (await admin
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
        created_by: SYSTEM_USER_ID,
      } as any)
      .select('id')
      .single()) as unknown as {
      data: LotRow | null
      error: { message: string } | null
    }

    if (lotRes.error || !lotRes.data) {
      return NextResponse.json(
        { error: lotRes.error?.message ?? 'Erro ao criar lote de estoque.' },
        { status: 500 }
      )
    }

    const stockRes = (await admin
      .from('stock')
      .select('quantity, avg_cost')
      .eq('product_variation_id', product_variation_id)
      .maybeSingle()) as unknown as {
      data: StockRow | null
      error: { message: string } | null
    }

    if (stockRes.error) {
      return NextResponse.json(
        { error: stockRes.error.message },
        { status: 500 }
      )
    }

    const prevQty = Number(stockRes.data?.quantity ?? 0)
    const prevAvgCost = Number(stockRes.data?.avg_cost ?? 0)
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
      return NextResponse.json(
        { error: stockError.message },
        { status: 500 }
      )
    }

    const { error: financeError } = await admin.from('finance_entries').insert({
      type: 'expense',
      category: 'stock_purchase',
      description: `Entrada de estoque — Lote #${lotRes.data.id}`,
      amount: total_lot_cost,
      reference_date: entry_date,
      stock_lot_id: lotRes.data.id,
      created_by: SYSTEM_USER_ID,
    } as any)

    if (financeError) {
      return NextResponse.json(
        { error: financeError.message },
        { status: 500 }
      )
    }

    return NextResponse.json({
      lot_id: lotRes.data.id,
      new_quantity: newQty,
      new_avg_cost: newAvgCost,
      total_lot_cost,
      cost_per_unit,
    })
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Erro interno ao registrar entrada.',
      },
      { status: 500 }
    )
  }
}