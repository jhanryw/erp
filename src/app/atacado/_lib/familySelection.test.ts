import { describe, it, expect } from 'vitest'
import { buildCartLines, clampQuantity, familyProducts, summarizeSelection } from './familySelection'
import type { WholesaleCatalogProduct } from '@/services/wholesale/catalog'

const variation = (id: number, price: number, max: number, available = true) =>
  ({ variationId: id, sku: `S${id}`, attributes: [{ type: 'Tamanho', value: `T${id}` }], price, available, lowStock: false, maxQuantity: available ? max : 0 })
const product = (id: number, color: string, variations: ReturnType<typeof variation>[], family: WholesaleCatalogProduct[] = []): WholesaleCatalogProduct => ({
  productId: id, name: `Calcinha ${color}`, brand: null, category: null, categorySlug: null, colorLabel: color,
  images: [{ url: `https://x/${id}.jpg`, alt: null }], variations, priceFrom: 10, purchasable: variations.some((v) => v.available), family,
})

const rosa = product(1, 'Rosa', [variation(11, 20, 5), variation(12, 22, 3)])
const preto = product(2, 'Preto', [variation(21, 20, 10), variation(22, 25, 0, false)])
const nude = product(3, 'Nude', [variation(31, 18, 2)])
const current = { ...rosa, family: [preto, nude, rosa] } // repete o próprio por engano

describe('seleção por família (várias cores)', () => {
  it('familyProducts: atual primeiro e sem duplicar', () => {
    expect(familyProducts(current).map((p) => p.productId)).toEqual([1, 2, 3])
    expect(familyProducts(rosa).map((p) => p.productId)).toEqual([1])
  })

  it('clampQuantity respeita estoque, indisponibilidade e valores inválidos', () => {
    expect(clampQuantity(variation(1, 1, 5), 9)).toBe(5)
    expect(clampQuantity(variation(1, 1, 5), -3)).toBe(0)
    expect(clampQuantity(variation(1, 1, 5), 2.9)).toBe(2)
    expect(clampQuantity(variation(1, 1, 5, false), 3)).toBe(0)
  })

  it('subtotal, total de peças e peças por cor somam todas as cores', () => {
    const products = familyProducts(current)
    const s = summarizeSelection(products, { 11: 2, 12: 1, 21: 4, 31: 1 })
    expect(s.units).toBe(8)
    expect(s.subtotal).toBe(2 * 20 + 22 + 4 * 20 + 18)
    expect(s.unitsByProduct).toEqual({ 1: 3, 2: 4, 3: 1 })
  })

  it('quantidade acima do estoque ou em variação indisponível não entra na soma', () => {
    const s = summarizeSelection(familyProducts(current), { 11: 99, 22: 5 })
    expect(s.units).toBe(5) // 11 limitado a 5; 22 indisponível = 0
    expect(s.subtotal).toBe(100)
  })

  it('linhas do carrinho: cada variação com o produto/foto da SUA cor', () => {
    const lines = buildCartLines(familyProducts(current), { 11: 2, 21: 1, 22: 3 })
    expect(lines.map((l) => [l.item.variationId, l.item.productId, l.item.productName, l.item.imageUrl, l.quantity])).toEqual([
      [11, 1, 'Calcinha Rosa', 'https://x/1.jpg', 2],
      [21, 2, 'Calcinha Preto', 'https://x/2.jpg', 1],
    ])
  })
})
