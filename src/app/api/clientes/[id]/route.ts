export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const n = (v: unknown) => (v === '' || v == null ? null : v)

const schema = z.object({
  name: z.string().min(2),
  phone: z.string().min(1),
  birth_date: z.preprocess(n, z.string().nullable().optional()),
  city: z.preprocess(n, z.string().nullable().optional()),
  origin: z.preprocess(n, z.string().nullable().optional()),
  notes: z.preprocess(n, z.string().nullable().optional()),
  active: z.boolean().default(true),
})

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const admin = createAdminClient()
  const { data, error } = (await admin.from('customers').select('*').eq('id', Number(params.id)).single()) as unknown as { data: any; error: any }
  if (error || !data) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 })
  return NextResponse.json({ customer: data })
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = createAdminClient()
  const { error } = (await (admin as any).from('customers').update(parsed.data).eq('id', Number(params.id))) as { error: any }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
