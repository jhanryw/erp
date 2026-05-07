import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const VIEWS = [
  'mv_abc_by_revenue',
  'mv_abc_by_profit',
  'mv_abc_by_volume',
  'mv_product_performance',
  'mv_stock_status',
  'mv_color_performance',
  'mv_supplier_performance',
  'mv_customer_rfm',
] as const

export async function GET() {
  const supabase = createAdminClient()
  const results: Record<string, { count: number | null; error: string | null; sample: any }> = {}

  for (const view of VIEWS) {
    const { data, error, count } = await (supabase as any)
      .from(view)
      .select('*', { count: 'exact' })
      .limit(1)

    results[view] = {
      count: count,
      error: error?.message ?? null,
      sample: data?.[0] ?? null,
    }
  }

  return NextResponse.json(results, { status: 200 })
}
