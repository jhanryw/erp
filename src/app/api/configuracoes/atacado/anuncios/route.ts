export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { announcementInputSchema, createAnnouncement, listAnnouncements } from '@/services/wholesale/announcements'

export async function GET() {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  try {
    return NextResponse.json(await listAnnouncements(user.company_id))
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Falha ao listar.' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 }) }
  const parsed = announcementInputSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Dados inválidos.', details: parsed.error.flatten() }, { status: 422 })

  const result = await createAnnouncement(user.company_id, parsed.data)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ announcement: result.data }, { status: 201 })
}
