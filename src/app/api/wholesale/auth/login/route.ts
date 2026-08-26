export const dynamic = 'force-dynamic'

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { loginWholesaleCustomer } from '@/services/wholesale/customerAuth'

const schema = z.object({ email: z.string().email(), password: z.string().min(1) })

export async function POST(request: Request) {
  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const result = await loginWholesaleCustomer(parsed.data.email, parsed.data.password)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ ok: true })
}
