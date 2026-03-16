import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

const VIEWS_HOURLY = ['mv_daily_sales_summary', 'mv_stock_status']
const VIEWS_6H = ['mv_product_performance', 'mv_abc_by_revenue', 'mv_abc_by_profit', 'mv_abc_by_volume', 'mv_color_performance']
const VIEWS_DAILY = ['mv_customer_rfm', 'mv_monthly_financial', 'mv_supplier_performance']

export async function POST(request: Request) {
  const authHeader = request.headers.get('Authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const schedule = searchParams.get('schedule') ?? 'hourly'

  const views =
    schedule === 'daily' ? VIEWS_DAILY :
    schedule === '6h' ? VIEWS_6H :
    VIEWS_HOURLY

  const supabase = createAdminClient()
  const results: { view: string; ok: boolean; error?: string }[] = []

  for (const view of views) {
    const { error } = await supabase.rpc('refresh_materialized_view', { view_name: view } as any)
    results.push({ view, ok: !error, error: error?.message })
  }

  return NextResponse.json({ schedule, results, timestamp: new Date().toISOString() })
}
