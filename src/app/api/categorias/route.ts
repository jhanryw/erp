export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'

export async function GET() {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const admin = createAdminClient()
  const { data, error } = (await (admin as any).from('categories').select('id, name').eq('company_id', user.company_id).order('name')) as unknown as { data: { id: number; name: string }[] | null; error: any }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ categories: data ?? [] })
}
