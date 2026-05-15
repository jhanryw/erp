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
    .select('id, name')
    .eq('active', true)
    .order('name', { ascending: true })) as unknown as {
    data: Array<{ id: number; name: string }> | null
    error: { message: string } | null
  }

  if (error || !products) {
    return NextResponse.json({ error: 'Erro ao buscar produtos.' }, { status: 500 })
  }

  return NextResponse.json({
    products: products.filter((p) => !mappedIds.has(p.id)),
  })
}
