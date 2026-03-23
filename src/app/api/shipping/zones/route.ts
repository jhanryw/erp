export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function GET() {
  try {
    const admin = createAdminClient()

    const { data: zones, error } = await admin
      .from('shipping_zones')
      .select('*')
      .eq('is_active', true)
      .order('priority', { ascending: true })

    if (error) throw error

    return NextResponse.json({ zones: zones || [] })
  } catch (error) {
    console.error('[API Shipping Zones]', error)
    return NextResponse.json({ error: 'Erro ao buscar zonas de envio' }, { status: 500 })
  }
}
