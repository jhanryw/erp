export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { setCategoryCover, removeCategoryCover } from '@/services/wholesale/categoryCovers'

const putSchema = z.object({ mediaPublicId: z.string().uuid() })

function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

// PUT — define/troca a capa (a imagem já foi enviada por POST /api/media, visibility=public).
export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const categoryId = parseId(params.id)
  if (!categoryId) return NextResponse.json({ error: 'id inválido.' }, { status: 400 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 }) }
  const parsed = putSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const result = await setCategoryCover(user.company_id, categoryId, parsed.data.mediaPublicId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true })
}

// DELETE — remove a capa (não apaga a mídia; a home volta a usar a foto de um produto da categoria).
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const categoryId = parseId(params.id)
  if (!categoryId) return NextResponse.json({ error: 'id inválido.' }, { status: 400 })

  const result = await removeCategoryCover(user.company_id, categoryId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ ok: true })
}
