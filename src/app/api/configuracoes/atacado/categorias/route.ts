export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { listCategoriesWithCovers } from '@/services/wholesale/categoryCovers'

// GET /api/configuracoes/atacado/categorias — categorias da empresa com a capa atual e a chave pública.
export async function GET() {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const categories = await listCategoriesWithCovers(user.company_id)
  return NextResponse.json({ categories })
}
