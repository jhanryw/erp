import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { resolveWholesalePublicContext } from '@/lib/wholesale/publicContext'
import { getWholesaleProductDetail } from '@/services/wholesale/catalog'
import { ProductDetailClient } from './ProductDetailClient'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const ctx = await resolveWholesalePublicContext()
  if (!ctx.ok) return { title: 'Produto' }
  const product = await getWholesaleProductDetail(ctx.companyId, Number(params.id))
  if (!product) return { title: 'Produto não encontrado' }
  return {
    title: product.name,
    description: `${product.name}${product.brand ? ` — ${product.brand}` : ''} — preço de atacado Santtorini.`,
  }
}

export default async function ProdutoPage({ params }: { params: { id: string } }) {
  const ctx = await resolveWholesalePublicContext()
  if (!ctx.ok) notFound()

  const productId = Number(params.id)
  if (!productId) notFound()

  const product = await getWholesaleProductDetail(ctx.companyId, productId)
  if (!product) notFound()

  return <ProductDetailClient product={product} />
}
