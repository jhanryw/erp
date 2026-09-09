export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

type VariationValueRow = {
  id: number
  value: string
  slug: string
  sku_code: string | null
  normalized_name: string | null
  variation_type_id: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAllVariationValues(admin: any, typeIds: number[]): Promise<VariationValueRow[]> {
  // O self-host tem um teto de linhas por resposta no PostgREST (confirmado
  // em produção: 109 linhas somadas entre os tipos ativos já bastam pra
  // cortar silenciosamente os ids mais altos, sem erro — request "parece"
  // ter dado certo mas devolve menos linhas do que existem). Pagina via
  // `count: 'exact'` + `.range()` até cobrir o total real, em vez de confiar
  // numa única chamada sem limite.
  const PAGE_SIZE = 500
  const all: VariationValueRow[] = []
  let from = 0

  while (true) {
    const { data, error, count } = (await admin
      .from('variation_values')
      .select('id, value, slug, sku_code, normalized_name, variation_type_id', { count: 'exact' })
      .in('variation_type_id', typeIds)
      .order('id')
      .range(from, from + PAGE_SIZE - 1)) as { data: VariationValueRow[] | null; error: any; count: number | null }

    if (error) throw error
    if (!data || data.length === 0) break

    all.push(...data)
    from += data.length

    if (count != null && from >= count) break
  }

  return all
}

export async function GET() {
  const admin = createAdminClient()

  // Query 1: tipos ativos
  const { data: types, error: typesError } = (await admin
    .from('variation_types')
    .select('id, name, slug, kind')
    .eq('active', true)
    .order('name')) as unknown as {
    data: { id: number; name: string; slug: string; kind: string }[] | null
    error: any
  }

  if (typesError) return NextResponse.json({ error: typesError.message }, { status: 500 })
  if (!types?.length) return NextResponse.json({ types: [] })

  // Query 2: todos os valores dos tipos ativos (paginado — ver fetchAllVariationValues)
  const typeIds = types.map(t => t.id)
  let values: VariationValueRow[]
  try {
    values = await fetchAllVariationValues(admin, typeIds)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }

  // Mesclar: cada tipo recebe seus valores
  const result = types.map(type => ({
    ...type,
    variation_values: values.filter(v => v.variation_type_id === type.id),
  }))

  return NextResponse.json({ types: result })
}
