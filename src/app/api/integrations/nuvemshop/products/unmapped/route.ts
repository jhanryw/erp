import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'

export async function GET() {
  const { response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  const admin = createAdminClient()

  const { data: mappedRows } = (await (admin as any)
    .from('produto_map')
    .select('produto_id')
    .eq('source', 'nuvemshop')
    .not('external_variant_id', 'is', null)) as { data: Array<{ produto_id: number }> | null }

  const mappedIds = new Set((mappedRows ?? []).map((r) => r.produto_id))

  const { data: products, error } = (await admin
    .from('products')
    .select(`
      id,
      name,
      product_variations (
        stock_balances ( quantity )
      )
    `)
    .eq('active', true)
    .order('name', { ascending: true })) as unknown as {
    data: Array<{
      id: number
      name: string
      product_variations: Array<{ stock_balances: Array<{ quantity: number }> }>
    }> | null
    error: { message: string } | null
  }

  if (error || !products) {
    return NextResponse.json({ error: 'Erro ao buscar produtos.' }, { status: 500 })
  }

  const withStock = products.filter((p) => {
    const total = p.product_variations.flatMap((v) => v.stock_balances).reduce((sum, s) => sum + (s.quantity ?? 0), 0)
    return total > 0
  })

  return NextResponse.json({
    products: withStock.filter((p) => !mappedIds.has(p.id)).map(({ id, name }) => ({ id, name })),
  })
}
