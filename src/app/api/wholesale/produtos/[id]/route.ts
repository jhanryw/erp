export const dynamic = 'force-dynamic'
// Catálogo/estoque/pedido NUNCA podem sair do cache de dados do Next (supabase-js usa fetch GET).
export const fetchCache = 'force-no-store'

import { NextResponse } from 'next/server'
import { publicRouteError, resolveWholesalePublicContext } from '@/lib/wholesale/publicContext'
import { getWholesaleProductDetail } from '@/services/wholesale/catalog'

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const ctx = await resolveWholesalePublicContext()
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

  const productId = Number(params.id)
  if (!productId || !Number.isInteger(productId)) {
    return NextResponse.json({ error: 'Produto inválido.' }, { status: 400 })
  }

  try {
    const product = await getWholesaleProductDetail(ctx.companyId, productId)
    if (!product) return NextResponse.json({ error: 'Produto não encontrado.' }, { status: 404 })
    return NextResponse.json({ product })
  } catch (err) {
    return publicRouteError('GET /api/wholesale/produtos/[id]', err, { company_id: ctx.companyId })
  }
}
