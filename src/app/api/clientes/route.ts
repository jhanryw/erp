export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const n = (v: unknown) => (v === '' || v == null ? null : v)

const schema = z.object({
  name: z.string().min(2),
  cpf: z.string().length(11),
  phone: z.string().min(1),
  birth_date: z.preprocess(n, z.string().nullable().optional()),
  city: z.preprocess(n, z.string().nullable().optional()),
  origin: z.preprocess(n, z.enum(['instagram', 'referral', 'paid_traffic', 'website', 'store', 'other']).nullable().optional()),
  notes: z.preprocess(n, z.string().nullable().optional()),
})

export async function POST(request: Request) {
  // Qualquer usuário autenticado pode cadastrar clientes (operação básica)
  const { response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const createdBy = process.env.SYSTEM_USER_ID
  if (!createdBy) return NextResponse.json({ error: 'SYSTEM_USER_ID não configurado.' }, { status: 500 })

  const admin = createAdminClient()
  const { data: customer, error } = (await admin
    .from('customers')
    .insert({ ...parsed.data, created_by: createdBy } as any)
    .select('id')
    .single()) as unknown as { data: { id: string } | null; error: any }

  if (error) {
    const msg = error.code === '23505' ? 'CPF já cadastrado.' : error.message
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({ customer }, { status: 201 })
}
