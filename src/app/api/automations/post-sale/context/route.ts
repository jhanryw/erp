import { NextResponse } from 'next/server'
import { getPostSaleContext } from '@/lib/automations/post-sale-context'

export const dynamic = 'force-dynamic'

function isAuthorized(request: Request): boolean {
  const secret = process.env.N8N_AUTOMATION_SECRET
  if (!secret) return false
  return request.headers.get('Authorization') === `Bearer ${secret}`
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const raw = searchParams.get('sale_id')
  const saleId = raw ? parseInt(raw, 10) : NaN

  if (!saleId || isNaN(saleId) || saleId <= 0) {
    return NextResponse.json({ error: 'sale_id inválido.' }, { status: 422 })
  }

  const context = await getPostSaleContext(saleId)

  if (!context) {
    return NextResponse.json({ error: 'Venda não encontrada.' }, { status: 404 })
  }

  return NextResponse.json(context)
}
