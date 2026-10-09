export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { deleteColorGroup, updateColorGroup } from '@/services/wholesale/colorGroups'

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  productIds: z.array(z.number().int().positive()).min(2).max(60).optional(),
})

function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  const id = parseId(params.id)
  if (!id) return NextResponse.json({ error: 'id inválido.' }, { status: 400 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 }) }
  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const result = await updateColorGroup(user.company_id, id, parsed.data)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  const id = parseId(params.id)
  if (!id) return NextResponse.json({ error: 'id inválido.' }, { status: 400 })

  const result = await deleteColorGroup(user.company_id, id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true })
}
