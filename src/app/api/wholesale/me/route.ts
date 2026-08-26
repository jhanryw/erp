export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { getWholesaleCustomerSession } from '@/lib/wholesale/session'

export async function GET() {
  const session = await getWholesaleCustomerSession()
  if (!session) return NextResponse.json({ customer: null })
  return NextResponse.json({
    customer: {
      name: session.name, email: session.email, phone: session.phone, cpf: session.cpf, cnpj: session.cnpj,
    },
  })
}
