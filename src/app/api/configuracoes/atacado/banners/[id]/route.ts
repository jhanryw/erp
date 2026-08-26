export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { updateWholesaleBanner, deleteWholesaleBanner, wholesaleBannerLinkSchema } from '@/services/wholesale/banners'

const patchSchema = z.object({
  isActive: z.boolean().optional(),
  link: wholesaleBannerLinkSchema.optional(),
})

// ─── PATCH /api/configuracoes/atacado/banners/[id] ─────────────────────────────

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const bannerId = Number(params.id)
  if (!Number.isInteger(bannerId) || bannerId <= 0) return NextResponse.json({ error: 'id inválido.' }, { status: 400 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 }) }

  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const result = await updateWholesaleBanner(user.company_id, bannerId, parsed.data)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ banner: result.data })
}

// ─── DELETE /api/configuracoes/atacado/banners/[id] ─────────────────────────────

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const bannerId = Number(params.id)
  if (!Number.isInteger(bannerId) || bannerId <= 0) return NextResponse.json({ error: 'id inválido.' }, { status: 400 })

  const result = await deleteWholesaleBanner(user.company_id, bannerId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ ok: true })
}
