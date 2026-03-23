export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const n = (v: unknown) => (v === '' || v == null ? null : v)

const schema = z.object({
  name: z.string().min(2),
  document: z.preprocess(n, z.string().nullable().optional()),
  phone: z.preprocess(n, z.string().nullable().optional()),
  city: z.preprocess(n, z.string().nullable().optional()),
  state: z.preprocess(n, z.string().length(2).nullable().optional()),
  notes: z.preprocess(n, z.string().nullable().optional()),
  active: z.boolean().default(true),
})

export async function GET() {
  const admin = createAdminClient()
  const { data, error } = (await admin.from('suppliers').select('id, name').eq('active', true).order('name')) as unknown as { data: { id: number; name: string }[] | null; error: any }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ suppliers: data ?? [] })
}

export async function POST(request: Request) {
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = createAdminClient()
  const { data: supplier, error } = (await admin
    .from('suppliers')
    .insert(parsed.data as any)
    .select('id')
    .single()) as unknown as { data: { id: number } | null; error: any }

  if (error) {
    const msg = error.code === '23505' ? 'CNPJ/CPF já cadastrado.' : error.message
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({ supplier }, { status: 201 })
}
