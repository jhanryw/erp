export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { sanitizePostgrestSearch } from '@/lib/utils/postgrest-search'
import { getVariationAvailability } from '@/services/inventory/availability.service'

export interface KitComponentSearchItem {
  product_variation_id: number
  product_id: number
  product_name: string
  sku_variation: string
  cor: string | null
  tamanho: string | null
  unit_cost: number
  available_main_store: number
  available_online: number
}

/**
 * GET /api/produtos/kits/componentes/buscar?q= — variações que PODEM ser
 * componente de kit: só produtos standard da empresa da sessão (kit dentro
 * de kit é proibido na V1), com estoque atual (loja e online) para o editor
 * mostrar "Estoque disponível / Permite N kits" antes de salvar.
 */
export async function GET(request: NextRequest) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  const companyId = user.company_id
  if (!companyId) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const q = sanitizePostgrestSearch(request.nextUrl.searchParams.get('q')?.trim() ?? '')
  if (q.length < 2) return NextResponse.json({ items: [] })

  const admin = createAdminClient()

  const { data: productRows } = await (admin as any)
    .from('products')
    .select('id')
    .eq('company_id', companyId)
    .eq('product_kind', 'standard')
    .ilike('name', `%${q}%`)
    .limit(20) as { data: Array<{ id: number }> | null }

  const productIds = (productRows ?? []).map((p) => p.id)
  const orFilter = productIds.length > 0
    ? `sku_variation.ilike.%${q}%,product_id.in.(${productIds.join(',')})`
    : `sku_variation.ilike.%${q}%`

  const { data: rows, error } = await (admin as any)
    .from('product_variations')
    .select(`
      id, sku_variation, cost_override, product_id,
      products!inner ( id, name, base_cost, company_id, product_kind ),
      product_variation_attributes (
        variation_types:variation_type_id ( slug ),
        variation_values:variation_value_id ( value )
      )
    `)
    .eq('products.company_id', companyId)
    .eq('products.product_kind', 'standard')
    .or(orFilter)
    .order('sku_variation')
    .limit(20) as {
      data: Array<{
        id: number
        sku_variation: string
        cost_override: number | null
        product_id: number
        products: { id: number; name: string; base_cost: number }
        product_variation_attributes: Array<{ variation_types: { slug: string } | null; variation_values: { value: string } | null }>
      }> | null
      error: { message: string } | null
    }

  if (error) {
    console.error('[api/produtos/kits/componentes/buscar] query error', error)
    return NextResponse.json({ error: 'Erro ao buscar componentes.' }, { status: 500 })
  }

  const ids = (rows ?? []).map((r) => r.id)
  const [mainRes, onlineRes] = await Promise.all([
    getVariationAvailability(companyId, ids, 'main_store'),
    getVariationAvailability(companyId, ids, 'online_priority'),
  ])

  const items: KitComponentSearchItem[] = (rows ?? []).map((r) => {
    const attrs = r.product_variation_attributes ?? []
    return {
      product_variation_id: r.id,
      product_id: r.product_id,
      product_name: r.products.name,
      sku_variation: r.sku_variation,
      cor: attrs.find((a) => a.variation_types?.slug === 'cor')?.variation_values?.value ?? null,
      tamanho: attrs.find((a) => a.variation_types?.slug === 'tamanho')?.variation_values?.value ?? null,
      unit_cost: Number(r.cost_override ?? r.products.base_cost ?? 0),
      available_main_store: mainRes.ok ? mainRes.data.get(r.id)?.sellable_quantity ?? 0 : 0,
      available_online: onlineRes.ok ? onlineRes.data.get(r.id)?.sellable_quantity ?? 0 : 0,
    }
  })

  return NextResponse.json({ items })
}
