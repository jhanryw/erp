/**
 * Situação de publicação Nuvemshop de todos os produtos ativos da empresa —
 * alimenta /configuracoes/nuvemshop. Estoque é só informativo (`stock_total`)
 * e nunca decide se o produto está publicado.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { ServiceOutcome } from '../produtos.service'
import {
  computeNuvemshopPublicationState,
  groupNuvemshopMappings,
  listNuvemshopMappingsForCompany,
  type NuvemshopPublicationState,
} from './mappings.service'

export interface NuvemshopPublicationItem {
  id:                 number
  name:               string
  state:              NuvemshopPublicationState
  remote_product_id:  string | null
  active_variations:  number
  mapped_variations:  number
  stock_total:        number
}

export interface NuvemshopPublicationOverview {
  items:  NuvemshopPublicationItem[]
  counts: Record<NuvemshopPublicationState, number> & { without_stock: number }
  total_variants_mapped: number
  last_stock_synced_at:  string | null
}

type ProductRow = {
  id: number
  name: string
  product_variations: Array<{ id: number; active: boolean; stock_balances: Array<{ quantity: number }> | null }> | null
}

const PAGE = 1000

export async function getNuvemshopPublicationOverview(companyId: number): Promise<ServiceOutcome<NuvemshopPublicationOverview>> {
  const admin = createAdminClient()
  const products: ProductRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await (admin as any)
      .from('products')
      .select('id, name, product_variations ( id, active, stock_balances ( quantity ) )')
      .eq('company_id', companyId)
      .eq('active', true)
      .order('name', { ascending: true })
      .range(from, from + PAGE - 1) as { data: ProductRow[] | null; error: { message: string } | null }
    if (error) return { ok: false, error: error.message, status: 500 }
    products.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }

  const rows = await listNuvemshopMappingsForCompany(companyId)
  if (!rows.ok) return rows
  const mappings = groupNuvemshopMappings(rows.data)

  const counts = { not_published: 0, published: 0, inconsistent: 0, without_stock: 0 }
  const items: NuvemshopPublicationItem[] = products.map((p) => {
    const active = (p.product_variations ?? []).filter((v) => v.active)
    const activeIds = active.map((v) => v.id)
    const mapping = mappings.get(p.id) ?? null
    const state = computeNuvemshopPublicationState(mapping, activeIds)
    const stockTotal = active.flatMap((v) => v.stock_balances ?? []).reduce((s, b) => s + (b.quantity ?? 0), 0)
    counts[state]++
    if (stockTotal <= 0) counts.without_stock++
    const mappedIds = new Set((mapping?.variantRows ?? []).map((r) => r.product_variation_id))
    return {
      id:                p.id,
      name:              p.name,
      state,
      remote_product_id: mapping?.remoteProductId ?? null,
      active_variations: activeIds.length,
      mapped_variations: activeIds.filter((id) => mappedIds.has(id)).length,
      stock_total:       stockTotal,
    }
  })

  const variantRows = rows.data.filter((r) => r.product_variation_id != null && r.external_variant_id != null)
  const lastSync = variantRows.map((r) => r.last_stock_synced_at).filter((d): d is string => !!d).sort().pop() ?? null

  return { ok: true, data: { items, counts, total_variants_mapped: variantRows.length, last_stock_synced_at: lastSync } }
}
