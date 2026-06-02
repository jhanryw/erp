export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

export async function GET() {
  const admin = createAdminClient()

  // Query 1: tipos ativos
  const { data: types, error: typesError } = (await admin
    .from('variation_types')
    .select('id, name, slug')
    .eq('active', true)
    .order('name')) as unknown as {
    data: { id: number; name: string; slug: string }[] | null
    error: any
  }

  if (typesError) return NextResponse.json({ error: typesError.message }, { status: 500 })
  if (!types?.length) return NextResponse.json({ types: [] })

  // Query 2: todos os valores dos tipos ativos (sem nested select — evita limite do PostgREST)
  const typeIds = types.map(t => t.id)
  const { data: values, error: valuesError } = (await admin
    .from('variation_values')
    .select('id, value, slug, sku_code, normalized_name, variation_type_id')
    .in('variation_type_id', typeIds)
    .order('id')) as unknown as {
    data: { id: number; value: string; slug: string; sku_code: string | null; normalized_name: string | null; variation_type_id: number }[] | null
    error: any
  }

  if (valuesError) return NextResponse.json({ error: valuesError.message }, { status: 500 })

  // Mesclar: cada tipo recebe seus valores
  const result = types.map(type => ({
    ...type,
    variation_values: (values ?? []).filter(v => v.variation_type_id === type.id),
  }))

  return NextResponse.json({ types: result })
}
