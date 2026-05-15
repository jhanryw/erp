import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'

export async function GET() {
  const { response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  const admin = createAdminClient()

  const [mappedProductsRes, totalVariantsRes, lastSyncRes] = await Promise.all([
    (admin as any)
      .from('produto_map')
      .select('produto_id')
      .eq('source', 'nuvemshop')
      .not('external_id', 'is', null) as Promise<{ data: Array<{ produto_id: number }> | null }>,

    (admin as any)
      .from('produto_map')
      .select('*', { count: 'exact', head: true })
      .eq('source', 'nuvemshop')
      .not('external_variant_id', 'is', null) as Promise<{ count: number | null }>,

    (admin as any)
      .from('produto_map')
      .select('last_stock_synced_at')
      .eq('source', 'nuvemshop')
      .not('last_stock_synced_at', 'is', null)
      .order('last_stock_synced_at', { ascending: false })
      .limit(1)
      .maybeSingle() as Promise<{ data: { last_stock_synced_at: string } | null }>,
  ])

  const totalProducts = new Set((mappedProductsRes.data ?? []).map((r) => r.produto_id)).size

  return NextResponse.json({
    total_products: totalProducts,
    total_variants: totalVariantsRes.count ?? 0,
    last_synced_at: lastSyncRes.data?.last_stock_synced_at ?? null,
  })
}
