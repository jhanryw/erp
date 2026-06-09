import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'

export async function GET(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')?.trim() ?? ''

  if (q.length < 2) {
    return NextResponse.json({ items: [] })
  }

  const admin = createAdminClient()

  const { data, error } = await (admin as any)
    .from('vw_stock_live')
    .select('product_variation_id, product_name, sku_variation, sku_parent, cor, tamanho, price, current_qty')
    .or(`product_name.ilike.%${q}%,sku_variation.ilike.%${q}%,sku_parent.ilike.%${q}%`)
    .gt('current_qty', 0)
    .order('product_name', { ascending: true })
    .limit(20) as unknown as { data: any[] | null; error: any }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ items: data ?? [] })
}
