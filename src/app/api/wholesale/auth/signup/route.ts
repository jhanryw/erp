export const dynamic = 'force-dynamic'

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { signupWholesaleCustomer } from '@/services/wholesale/customerAuth'
import { validateCPF } from '@/lib/utils/cpf'
import { validateCNPJ } from '@/lib/utils/cnpj'

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Senha deve ter ao menos 8 caracteres.'),
  name: z.string().min(2),
  phone: z.string().min(8),
  cpf: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  cnpj: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
})

export async function POST(request: Request) {
  const tenant = await resolveWholesaleSiteTenant()
  if (!tenant) return NextResponse.json({ error: 'Site de atacado não configurado.' }, { status: 503 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  if (parsed.data.cpf && !validateCPF(parsed.data.cpf)) {
    return NextResponse.json({ error: 'CPF inválido.' }, { status: 422 })
  }
  if (parsed.data.cnpj && !validateCNPJ(parsed.data.cnpj)) {
    return NextResponse.json({ error: 'CNPJ inválido.' }, { status: 422 })
  }

  const result = await signupWholesaleCustomer({ companyId: tenant.companyId, ...parsed.data })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ ok: true })
}
