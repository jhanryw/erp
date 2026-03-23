import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const n = (v: unknown) => (v === '' || v == null ? null : v)

const schema = z.object({
  name: z.string().min(2),
  cpf: z.string().length(11),
  phone: z.string().min(1),
  birth_date: z.preprocess(n, z.string().nullable().optional()),
  city: z.preprocess(n, z.string().nullable().optional()),
  origin: z.preprocess(n, z.string().nullable().optional()),
  notes: z.preprocess(n, z.string().nullable().optional()),
})

export async function POST(request: Request) {
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = createAdminClient()
  const { data: customer, error } = (await admin
    .from('customers')
    .insert(parsed.data as any)
    .select('id')
    .single()) as unknown as { data: { id: string } | null; error: any }

  if (error) {
    const msg = error.code === '23505' ? 'CPF já cadastrado.' : error.message
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({ customer }, { status: 201 })
}
