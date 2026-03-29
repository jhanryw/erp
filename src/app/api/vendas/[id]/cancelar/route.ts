import { createAdminClient } from '@/lib/supabase/admin'
import { requireSession } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const { response: unauth } = await requireSession()
  if (unauth) return unauth

  const saleId = Number(params.id)
  const admin = createAdminClient()

  const systemUserId = process.env.SYSTEM_USER_ID
  if (!systemUserId) return NextResponse.json({ error: 'SYSTEM_USER_ID não configurado.' }, { status: 500 })

  const { data: sale } = await admin
    .from('sales')
    .select('*, sale_items(*)')
    .eq('id', saleId)
    .single() as unknown as { data: any }

  if (!sale) return NextResponse.json({ error: 'Venda não encontrada' }, { status: 404 })

  if (sale.status === 'cancelled' || sale.status === 'returned') {
    return NextResponse.json({ error: 'Venda já cancelada ou devolvida' }, { status: 400 })
  }

  // Restaurar estoque de cada item
  for (const item of (sale.sale_items ?? []) as any[]) {
    const { data: current } = await admin
      .from('stock')
      .select('quantity, avg_cost')
      .eq('product_variation_id', item.product_variation_id)
      .single() as unknown as { data: { quantity: number; avg_cost: number } | null }

    await admin.from('stock').upsert(
      {
        product_variation_id: item.product_variation_id,
        quantity: (current?.quantity ?? 0) + item.quantity,
        avg_cost: current?.avg_cost ?? item.unit_cost,
        last_updated: new Date().toISOString(),
      } as any,
      { onConflict: 'product_variation_id' }
    )
  }

  // Atualizar status
  await (admin.from('sales') as any).update({ status: 'cancelled' }).eq('id', saleId)

  // Registrar estorno financeiro
  await admin.from('finance_entries').insert({
    type: 'expense',
    category: 'other_expense',
    description: `Cancelamento — Venda ${sale.sale_number}`,
    amount: sale.total,
    reference_date: new Date().toISOString().slice(0, 10),
    sale_id: saleId,
    created_by: systemUserId,
  } as any)

  return NextResponse.json({ ok: true })
}
