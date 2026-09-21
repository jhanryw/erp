import { describe, it, expect } from 'vitest'
import { applyValidationToCart, type ValidationResponse } from './cartSync'
import type { CartItem } from './CartContext'

const item = (variationId: number, over: Partial<CartItem> = {}): CartItem => ({
  variationId, productId: 1, productName: `Prod ${variationId}`, sku: `S${variationId}`, attributes: 'M',
  displayPrice: 20, quantity: 3, imageUrl: null, ...over,
})
const response = (items: ValidationResponse['items']): ValidationResponse => ({
  valid: items.every((i) => i.ok), items, summary: { subtotal: 0, minimumOrderAmount: 300, meetsMinimum: false, missingForMinimum: 300 },
})

describe('applyValidationToCart (revalidação ao abrir e ao enviar)', () => {
  it('preço mudou → atualiza o preço e informa', () => {
    const r = applyValidationToCart([item(1)], response([{ variationId: 1, ok: true, price: 25, availableQuantity: 10 }]))
    expect(r.items[0]).toMatchObject({ displayPrice: 25, quantity: 3, maxQuantity: 10 })
    expect(r.messages[0]).toMatch(/preço atualizado/)
  })

  it('nada mudou → sem mensagens; guarda o estoque máximo conhecido', () => {
    const r = applyValidationToCart([item(1)], response([{ variationId: 1, ok: true, price: 20, availableQuantity: 8 }]))
    expect(r.messages).toEqual([])
    expect(r.items[0].maxQuantity).toBe(8)
  })

  it('quantidade acima do estoque → ajustada ao disponível', () => {
    const r = applyValidationToCart([item(1, { quantity: 10 })], response([{ variationId: 1, ok: false, reason: 'insufficient_stock', price: 20, availableQuantity: 4 }]))
    expect(r.items[0]).toMatchObject({ quantity: 4, maxQuantity: 4 })
    expect(r.messages[0]).toMatch(/só há 4/)
  })

  it('item que ficou sem estoque → removido', () => {
    const r = applyValidationToCart([item(1)], response([{ variationId: 1, ok: false, reason: 'insufficient_stock', price: 20, availableQuantity: 0 }]))
    expect(r.items).toEqual([])
    expect(r.messages[0]).toMatch(/sem estoque/)
  })

  it('produto removido do atacado → removido e informado', () => {
    const r = applyValidationToCart([item(1), item(2)], response([
      { variationId: 1, ok: false, reason: 'not_enabled', price: null, availableQuantity: 0 },
      { variationId: 2, ok: true, price: 20, availableQuantity: 9 },
    ]))
    expect(r.items.map((i) => i.variationId)).toEqual([2])
    expect(r.messages[0]).toMatch(/atacado/)
  })

  it('inativo / sem preço / inexistente → removidos', () => {
    const r = applyValidationToCart([item(1), item(2), item(3)], response([
      { variationId: 1, ok: false, reason: 'inactive', price: null, availableQuantity: 0 },
      { variationId: 2, ok: false, reason: 'no_wholesale_price', price: null, availableQuantity: 0 },
      { variationId: 3, ok: false, reason: 'not_found', price: null, availableQuantity: 0 },
    ]))
    expect(r.items).toEqual([])
    expect(r.messages).toHaveLength(3)
  })

  it('item ausente da resposta é mantido como está', () => {
    expect(applyValidationToCart([item(9)], response([])).items).toHaveLength(1)
  })

  it('nunca aumenta a quantidade', () => {
    const r = applyValidationToCart([item(1, { quantity: 2 })], response([{ variationId: 1, ok: true, price: 20, availableQuantity: 50 }]))
    expect(r.items[0].quantity).toBe(2)
  })
})
