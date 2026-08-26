import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { getWholesaleProductDetail } from '@/services/wholesale/catalog'
import { ProductDetailClient } from './ProductDetailClient'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const tenant = await resolveWholesaleSiteTenant()
  if (!tenant) return { title: 'Produto' }
  const product = await getWholesaleProductDetail(tenant.companyId, Number(params.id))
  if (!product) return { title: 'Produto não encontrado' }
  return {
    title: product.name,
    description: `${product.name}${product.brand ? ` — ${product.brand}` : ''} — preço de atacado Santtorini.`,
  }
}

export default async function ProdutoPage({ params }: { params: { id: string } }) {
  const tenant = await resolveWholesaleSiteTenant()
  if (!tenant) notFound()

  const productId = Number(params.id)
  if (!productId) notFound()

  const product = await getWholesaleProductDetail(tenant.companyId, productId)
  if (!product) notFound()

  return <ProductDetailClient product={product} />
}
