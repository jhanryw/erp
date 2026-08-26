export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { logoutWholesaleCustomer } from '@/services/wholesale/customerAuth'

export async function POST() {
  await logoutWholesaleCustomer()
  return NextResponse.json({ ok: true })
}
