import type { SupabaseClient } from '@supabase/supabase-js'
import { selectAllInChunks } from './queryBatching'

interface AttributeRow {
  product_variation_id: number
  variation_types: { name: string } | { name: string }[] | null
  variation_values: { value: string } | { value: string }[] | null
}

export type VariationAttribute = { type: string; value: string }

const one = <T,>(embed: T | T[] | null | undefined): T | null => (Array.isArray(embed) ? (embed[0] ?? null) : (embed ?? null))

/** Atributos (cor/tamanho…) por variação, em lote. Compartilhado por catálogo e snapshot de pedido. */
export async function loadAttributesByVariation(admin: SupabaseClient, variationIds: number[]): Promise<Record<number, VariationAttribute[]>> {
  const rows = await selectAllInChunks<AttributeRow, number>(variationIds, (chunk, from, to) =>
    (admin as any)
      .from('product_variation_attributes')
      .select('product_variation_id, variation_types:variation_type_id(name), variation_values:variation_value_id(value)')
      .in('product_variation_id', chunk)
      .order('product_variation_id', { ascending: true })
      .order('variation_type_id', { ascending: true })
      .range(from, to),
  )

  const byVariation: Record<number, VariationAttribute[]> = {}
  for (const a of rows) {
    const value = one(a.variation_values)?.value
    if (!value) continue
    const list = byVariation[a.product_variation_id] ?? []
    list.push({ type: one(a.variation_types)?.name ?? '', value })
    byVariation[a.product_variation_id] = list
  }
  return byVariation
}
