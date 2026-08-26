export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { reorderWholesaleBanners } from '@/services/wholesale/banners'

// Espera a lista COMPLETA de ids de banners da empresa, na nova ordem —
// ids que não pertencem à empresa são ignorados (ver reorderWholesaleBanners).

const schema = z.object({
  bannerIds: z.array(z.number().int().positive()).min(1),
})

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const result = await reorderWholesaleBanners(user.company_id, parsed.data.bannerIds)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ ok: true })
}
