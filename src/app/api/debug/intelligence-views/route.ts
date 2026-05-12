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
  const results: Record<string, { count: number | null; error: string | null; columns: string[]; sample: any }> = {}

  for (const view of VIEWS) {
    const { data, error, count } = await (supabase as any)
      .from(view)
      .select('*', { count: 'exact' })
      .limit(1)

    results[view] = {
      count: count,
      error: error?.message ?? null,
      columns: data?.[0] ? Object.keys(data[0]) : [],
      sample: data?.[0] ?? null,
    }
  }

  // Tenta executar a função de refresh para ver se existe
  const { error: fnError } = await (supabase as any).rpc('refresh_analytics_views').maybeSingle()
  const refreshFnExists = !fnError || !fnError.message.includes('does not exist')

  return NextResponse.json({ views: results, refresh_fn_exists: refreshFnExists }, { status: 200 })
}

// Faz o refresh de todas as views via SQL direto (fallback quando a função não existe)
export async function POST() {
  const supabase = createAdminClient()

  // Tenta via função RPC primeiro
  const { data: rpcData, error: rpcError } = await (supabase as any).rpc('refresh_analytics_views')
  if (!rpcError) {
    return NextResponse.json({ ok: true, method: 'rpc', result: rpcData })
  }

  // Fallback: refresh individual de cada view na ordem certa
  const views = [
    'mv_product_performance',   // base para ABC
    'mv_abc_by_revenue',
    'mv_abc_by_profit',
    'mv_abc_by_volume',
    'mv_daily_sales_summary',
    'mv_stock_status',
    'mv_color_performance',
    'mv_supplier_performance',
    'mv_customer_rfm',
    'mv_monthly_financial',
  ]

  const results: { view: string; ok: boolean; error?: string }[] = []
  for (const view of views) {
    const { error } = await (supabase as any).rpc('refresh_materialized_view', { view_name: view })
    results.push({ view, ok: !error, error: error?.message })
  }

  return NextResponse.json({ ok: true, method: 'individual', results })
}
