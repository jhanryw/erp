import type { CartItem } from './CartContext'
import { buildCartItem } from './cartItem'
import type { WholesaleCatalogProduct, WholesaleCatalogVariation } from '@/services/wholesale/catalog'

/** Quantidades por VARIAÇÃO, de todas as cores do modelo (persistem ao alternar de cor). */
export type FamilyQuantities = Record<number, number>

export interface SelectionSummary {
  units: number
  subtotal: number
  /** Unidades por produto (cor) — para o selo de cada cor. */
  unitsByProduct: Record<number, number>
}

/** Produto atual + outras cores, sem repetir produto. */
export function familyProducts(product: WholesaleCatalogProduct): WholesaleCatalogProduct[] {
  const seen = new Set<number>([product.productId])
  const others = (product.family ?? []).filter((p) => (seen.has(p.productId) ? false : (seen.add(p.productId), true)))
  return [product, ...others]
}

export function clampQuantity(variation: WholesaleCatalogVariation, requested: number): number {
  if (!variation.available) return 0
  return Math.max(0, Math.min(Math.floor(requested), variation.maxQuantity))
}

export function summarizeSelection(products: WholesaleCatalogProduct[], quantities: FamilyQuantities): SelectionSummary {
  let units = 0, subtotal = 0
  const unitsByProduct: Record<number, number> = {}
  for (const p of products) {
    for (const v of p.variations) {
      const q = clampQuantity(v, quantities[v.variationId] ?? 0)
      if (q <= 0) continue
      units += q
      subtotal += q * v.price
      unitsByProduct[p.productId] = (unitsByProduct[p.productId] ?? 0) + q
    }
  }
  return { units, subtotal: Math.round(subtotal * 100) / 100, unitsByProduct }
}

/** Linhas a adicionar ao carrinho — cada variação com o SEU produto (nome/foto da cor escolhida). */
export function buildCartLines(products: WholesaleCatalogProduct[], quantities: FamilyQuantities): Array<{ item: Omit<CartItem, 'quantity'>; quantity: number }> {
  const lines: Array<{ item: Omit<CartItem, 'quantity'>; quantity: number }> = []
  for (const p of products) {
    for (const v of p.variations) {
      const quantity = clampQuantity(v, quantities[v.variationId] ?? 0)
      if (quantity > 0) lines.push({ item: buildCartItem(p, v), quantity })
    }
  }
  return lines
}
