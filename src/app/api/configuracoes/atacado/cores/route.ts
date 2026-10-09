export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { createColorGroup, listColorGroups } from '@/services/wholesale/colorGroups'

// GET — grupos de cores da empresa, produtos sem grupo e SUGESTÕES (nunca aplicadas automaticamente).
export async function GET() {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  try {
    return NextResponse.json(await listColorGroups(user.company_id))
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Falha ao listar.' }, { status: 500 })
  }
}

const postSchema = z.object({
  name: z.string().trim().min(1).max(120),
  productIds: z.array(z.number().int().positive()).min(2).max(60),
})

// POST — cria um grupo com os produtos escolhidos por uma pessoa.
export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 }) }
  const parsed = postSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const result = await createColorGroup(user.company_id, parsed.data.name, parsed.data.productIds)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ id: result.data.id }, { status: 201 })
}
