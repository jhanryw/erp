export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'

export async function GET() {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  try {
    const admin = createAdminClient()

    const { data: zones, error } = await (admin as any)
      .from('shipping_zones')
      .select('*')
      .eq('company_id', user.company_id)
      .eq('is_active', true)
      .order('priority', { ascending: true })

    if (error) throw error

    return NextResponse.json({ zones: zones || [] })
  } catch (error) {
    console.error('[API Shipping Zones]', error)
    return NextResponse.json({ error: 'Erro ao buscar zonas de envio' }, { status: 500 })
  }
}
