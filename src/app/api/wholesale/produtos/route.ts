export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { getWholesaleCatalogPage } from '@/services/wholesale/catalog'

export async function GET(request: Request) {
  const tenant = await resolveWholesaleSiteTenant()
  if (!tenant) return NextResponse.json({ error: 'Site de atacado não configurado.' }, { status: 503 })

  const { searchParams } = new URL(request.url)
  const search = searchParams.get('q') ?? undefined
  const categorySlug = searchParams.get('categoria') ?? undefined
  const page = Number(searchParams.get('page') ?? '1')

  const result = await getWholesaleCatalogPage(tenant.companyId, { search, categorySlug, page })
  return NextResponse.json(result)
}
