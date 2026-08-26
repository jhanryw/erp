export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { listWholesaleBanners, createWholesaleBanner, wholesaleBannerLinkSchema } from '@/services/wholesale/banners'

// ─── GET /api/configuracoes/atacado/banners — todos (ativos e inativos) ───────

export async function GET() {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const banners = await listWholesaleBanners(user.company_id)
  return NextResponse.json({ banners })
}

// ─── POST /api/configuracoes/atacado/banners — cria banner ────────────────────

const postSchema = z.object({
  mediaPublicId: z.string().uuid(),
  link: wholesaleBannerLinkSchema,
})

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 }) }

  const parsed = postSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const result = await createWholesaleBanner(user.company_id, parsed.data)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ banner: result.data }, { status: 201 })
}
