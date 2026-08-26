export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { getWholesaleProductDetail } from '@/services/wholesale/catalog'

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const tenant = await resolveWholesaleSiteTenant()
  if (!tenant) return NextResponse.json({ error: 'Site de atacado não configurado.' }, { status: 503 })

  const productId = Number(params.id)
  if (!productId || !Number.isInteger(productId)) {
    return NextResponse.json({ error: 'Produto inválido.' }, { status: 400 })
  }

  const product = await getWholesaleProductDetail(tenant.companyId, productId)
  if (!product) return NextResponse.json({ error: 'Produto não encontrado.' }, { status: 404 })

  return NextResponse.json({ product })
}
