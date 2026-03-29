export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { createCustomer } from '@/services/clientes.service'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const n = (v: unknown) => (v === '' || v == null ? null : v)

const schema = z.object({
  name:       z.string().min(2),
  cpf:        z.string().length(11),
  phone:      z.string().min(1),
  birth_date: z.preprocess(n, z.string().nullable().optional()),
  city:       z.preprocess(n, z.string().nullable().optional()),
  origin:     z.preprocess(n, z.enum(['instagram', 'referral', 'paid_traffic', 'website', 'store', 'other']).nullable().optional()),
  notes:      z.preprocess(n, z.string().nullable().optional()),
})

export async function POST(request: Request) {
  // Qualquer usuário autenticado pode cadastrar clientes (operação básica de atendimento)
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const systemUserId = process.env.SYSTEM_USER_ID
  if (!systemUserId) return NextResponse.json({ error: 'SYSTEM_USER_ID não configurado.' }, { status: 500 })

  const result = await createCustomer(parsed.data, systemUserId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'create', resource: 'customer',
    resourceId: String(result.data.id), detail: parsed.data.name,
  })
  return NextResponse.json({ customer: result.data }, { status: 201 })
}
