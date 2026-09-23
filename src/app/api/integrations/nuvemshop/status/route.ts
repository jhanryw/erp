import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { getNuvemshopPublicationOverview } from '@/services/nuvemshop/publicationStatus.service'

export async function GET() {
  const { user, response } = await requireRole('gerente')
  if (response) return response
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa.' }, { status: 403 })

  const overview = await getNuvemshopPublicationOverview(user.company_id)
  if (!overview.ok) return NextResponse.json({ error: overview.error }, { status: 500 })

  return NextResponse.json({
    total_products:     overview.data.counts.published,
    inconsistent:       overview.data.counts.inconsistent,
    not_published:      overview.data.counts.not_published,
    total_variants:     overview.data.total_variants_mapped,
    last_synced_at:     overview.data.last_stock_synced_at,
  })
}
