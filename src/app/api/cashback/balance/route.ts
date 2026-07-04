import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ available_balance: 0 })

  const { searchParams } = new URL(request.url)
  const customerId = parseInt(searchParams.get('customer_id') ?? '0', 10)
  if (!customerId || customerId <= 0) return NextResponse.json({ available_balance: 0 })

  const admin = createAdminClient()
  const { data } = await (admin as any)
    .from('v_cashback_balance')
    .select('available_balance')
    .eq('customer_id', customerId)
    .eq('company_id', user.company_id)
    .maybeSingle() as { data: { available_balance: number } | null }

  return NextResponse.json({ available_balance: data?.available_balance ?? 0 })
}
