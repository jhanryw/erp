export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'

export type ProductSearchItem = {
  variation_id: number
  sku: string
  product_name: string
  price: number
  cost: number
  cor: string | null
  tamanho: string | null
  stock: number
}

export async function GET(request: NextRequest) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  const companyId = user.company_id
  if (!companyId) {
    return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  }

  const q = request.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) {
    return NextResponse.json({ items: [] })
  }

  const admin = createAdminClient()

  // Parallel: get main store ID + product IDs matching name
  const [mainStoreRes, productIdsRes] = await Promise.all([
    admin
      .from('stock_locations')
      .select('id')
      .eq('company_id', companyId)
      .eq('is_main_store', true)
      .single() as unknown as Promise<{ data: { id: number } | null; error: unknown }>,
    admin
      .from('products')
      .select('id')
      .eq('company_id', companyId)
      .eq('active', true)
      .ilike('name', `%${q}%`)
      .limit(12) as unknown as Promise<{ data: Array<{ id: number }> | null; error: unknown }>,
  ])

  if (!mainStoreRes.data) {
    return NextResponse.json({ error: 'Estoque loja não configurado.' }, { status: 500 })
  }

  const mainStoreId = mainStoreRes.data.id
  const productIds = (productIdsRes.data ?? []).map((p) => p.id)

  // Build OR filter: match SKU or product name (via IDs from first query)
  const orFilter =
    productIds.length > 0
      ? `sku_variation.ilike.%${q}%,product_id.in.(${productIds.join(',')})`
      : `sku_variation.ilike.%${q}%`

  type RawVariation = {
    id: number
    sku_variation: string
    price_override: number | null
    cost_override: number | null
    stock_balances: Array<{ quantity: number; stock_location_id: number }>
    products: { id: number; name: string; base_price: number; base_cost: number } | null
    product_variation_attributes: Array<{
      variation_types: { slug: string } | null
      variation_values: { value: string } | null
    }>
  }

  const { data: rows, error } = (await admin
    .from('product_variations')
    .select(`
      id,
      sku_variation,
      price_override,
      cost_override,
      stock_balances!inner (quantity, stock_location_id),
      products!inner (id, name, base_price, base_cost),
      product_variation_attributes (
        variation_types:variation_type_id (slug),
        variation_values:variation_value_id (value)
      )
    `)
    .eq('active', true)
    .eq('products.active', true)
    .eq('stock_balances.stock_location_id', mainStoreId)
    .gt('stock_balances.quantity', 0)
    .or(orFilter)
    .limit(12)) as unknown as { data: RawVariation[] | null; error: { message: string } | null }

  if (error) {
    console.error('[api/produtos/buscar] query error', error)
    return NextResponse.json({ error: 'Erro ao buscar produtos.' }, { status: 500 })
  }

  const items: ProductSearchItem[] = (rows ?? []).map((v) => {
    const attrs = v.product_variation_attributes ?? []
    const cor = attrs.find((a) => a.variation_types?.slug === 'cor')?.variation_values?.value ?? null
    const tamanho = attrs.find((a) => a.variation_types?.slug === 'tamanho')?.variation_values?.value ?? null

    // Sum only the main-store balance (already filtered by stock_location_id = mainStoreId)
    const stock = v.stock_balances.reduce((sum, b) => sum + (b.quantity ?? 0), 0)

    return {
      variation_id: v.id,
      sku:          v.sku_variation,
      product_name: v.products?.name ?? `Variação #${v.id}`,
      price:        v.price_override ?? v.products?.base_price ?? 0,
      cost:         v.cost_override  ?? v.products?.base_cost  ?? 0,
      cor,
      tamanho,
      stock,
    }
  })

  return NextResponse.json({ items })
}
