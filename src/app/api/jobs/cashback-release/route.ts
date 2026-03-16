import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  // Proteger endpoint com CRON_SECRET
  const authHeader = request.headers.get('Authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const today = new Date().toISOString().split('T')[0]

  const { data, error } = await (supabase
    .from('cashback_transactions') as any)
    .update({ status: 'available' })
    .eq('status', 'pending')
    .lte('release_date', today)
    .select('id') as { data: any[] | null, error: any }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ released: data?.length ?? 0, date: today })
}
