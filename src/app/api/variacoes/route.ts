export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

export async function GET() {
  const admin = createAdminClient()

  const { data: types, error } = (await admin
    .from('variation_types')
    .select('id, name, slug, variation_values(id, value, slug)')
    .eq('active', true)
    .order('name')) as unknown as {
    data: {
      id: number
      name: string
      slug: string
      variation_values: { id: number; value: string; slug: string }[]
    }[] | null
    error: any
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ types: types ?? [] })
}
