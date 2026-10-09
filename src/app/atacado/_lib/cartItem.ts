import type { CartItem } from './CartContext'
import type { WholesaleCatalogProduct, WholesaleCatalogVariation } from '@/services/wholesale/catalog'

/** Rótulo de uma variação — atributos (ex.: "Preto / M") ou o SKU quando o produto não tem variante de fato. */
export function variationLabel(attributes: { type: string; value: string }[], sku: string): string {
  return attributes.map((a) => a.value).join(' / ') || sku
}

/**
 * Item de carrinho a partir do DTO público do catálogo — ÚNICO ponto que monta um `CartItem`
 * (página de produto e recomendações usam o mesmo, sem duplicar regra). O preço aqui é só de
 * exibição: o servidor revalida tudo na abertura do carrinho e no envio do pedido.
 */
export function buildCartItem(product: WholesaleCatalogProduct, variation: WholesaleCatalogVariation): Omit<CartItem, 'quantity'> {
  return {
    variationId: variation.variationId,
    productId: product.productId,
    productName: product.name,
    sku: variation.sku,
    attributes: variation.attributes.map((a) => a.value).join(' · '),
    displayPrice: variation.price,
    imageUrl: product.images[0]?.url ?? null,
    maxQuantity: variation.maxQuantity,
  }
}

/** Variações que podem ser pedidas agora. */
export function availableVariations(product: WholesaleCatalogProduct): WholesaleCatalogVariation[] {
  return product.variations.filter((v) => v.available && v.maxQuantity > 0)
}

/** Ids dos PRODUTOS no carrinho — todas as variações do mesmo produto contam como um. */
export function cartProductIds(items: Pick<CartItem, 'productId'>[]): number[] {
  return Array.from(new Set(items.map((i) => i.productId))).sort((a, b) => a - b)
}

/** Remove da lista de recomendações o que já está no carrinho e o que deixou de ter variação comprável. */
export function filterRecommendations(products: WholesaleCatalogProduct[], inCart: number[]): WholesaleCatalogProduct[] {
  const excluded = new Set(inCart)
  const seen = new Set<number>()
  return products.filter((p) => {
    if (excluded.has(p.productId) || seen.has(p.productId) || availableVariations(p).length === 0) return false
    seen.add(p.productId)
    return true
  })
}
