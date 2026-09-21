export const dynamic = 'force-dynamic'
// Catálogo/estoque/pedido NUNCA podem sair do cache de dados do Next (supabase-js usa fetch GET).
export const fetchCache = 'force-no-store'

import { NextResponse } from 'next/server'
import { publicRouteError, resolveWholesalePublicContext } from '@/lib/wholesale/publicContext'
import { getWholesaleCatalogPage } from '@/services/wholesale/catalog'

export async function GET(request: Request) {
  const ctx = await resolveWholesalePublicContext()
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

  const { searchParams } = new URL(request.url)
  const search = searchParams.get('q')?.trim().slice(0, 100) || undefined
  const categorySlug = searchParams.get('categoria') ?? undefined
  const page = Number(searchParams.get('page') ?? '1')

  try {
    const result = await getWholesaleCatalogPage(ctx.companyId, { search, categorySlug, page })
    return NextResponse.json(result)
  } catch (err) {
    return publicRouteError('GET /api/wholesale/produtos', err, { company_id: ctx.companyId })
  }
}
