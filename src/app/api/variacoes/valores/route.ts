export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  variation_type_id: z.coerce.number().int().positive(),
  value: z.string().min(1, 'Nome obrigatório').max(50),
})

function toSlug(text: string) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .trim()
}

export async function POST(request: Request) {
  const { response: unauth } = await requireRole('admin')
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const slug = toSlug(parsed.data.value)
  const admin = createAdminClient()

  const { data, error } = (await admin
    .from('variation_values')
    .insert({ ...parsed.data, slug, active: true } as any)
    .select('id, value, slug')
    .single()) as unknown as { data: { id: number; value: string; slug: string } | null; error: any }

  if (error) {
    const msg = error.code === '23505' ? 'Valor já existe neste tipo.' : error.message
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  return NextResponse.json({ value: data }, { status: 201 })
}

export async function DELETE(request: Request) {
  const { response: unauth } = await requireRole('admin')
  if (unauth) return unauth

  const { searchParams } = new URL(request.url)
  const id = Number(searchParams.get('id'))
  if (!id) return NextResponse.json({ error: 'ID obrigatório' }, { status: 400 })

  const admin = createAdminClient()
  const { error } = (await (admin as any).from('variation_values').delete().eq('id', id)) as { error: any }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
