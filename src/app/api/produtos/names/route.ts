export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'

export async function GET() {
  // Fase 2 (ajuste final) — usuario = admin fora dos 9 módulos bloqueados.
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ products: [] })

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('products')
    .select('name, tipo, modelo, ano')
    .eq('company_id', user.company_id)
    .order('name')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ products: data ?? [] })
}
